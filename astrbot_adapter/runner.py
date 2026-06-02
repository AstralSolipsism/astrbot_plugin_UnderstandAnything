from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
import subprocess
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.core.message.components import Plain
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.star import Context

from .astrbot_host import AstrBotHostAdapter
from .computer_use import ensure_computer_use_enabled
from .constants import (
    AGENT_PROMPTS_ROOT,
    PLUGIN_NAME,
    PLUGIN_SKILLS_ROOT,
    SKILL_COMMANDS,
)
from .github_repo import (
    DEFAULT_GIT_COMMAND_TIMEOUT_SECONDS,
    GitHubRepoCheckout,
    GitHubRepoError,
    GitHubRepoManager,
)
from .ignore_review import (
    apply_confirmation_reply,
    build_ignore_confirmation,
    parse_confirmation_reply,
    write_ignore_content,
)
from .job_request import format_job_args, parse_job_args, quote_arg, split_args
from .job_store import JobSnapshot, JobStatus, JobStore
from .llm_dispatcher import LLMDispatcher, read_prompt_file
from .path_security import PathSecurity
from .project_registry import ProjectRegistry, ProjectRegistryError, ProjectStatus
from .project_store import ProjectStore
from .runtime import UnderstandAnythingRuntime
from .subagent_dispatcher import UnderstandAnythingSubAgentDispatcher
from .subagent_registry import UnderstandAnythingSubAgentRegistry

REQUIRED_GRAPH_OUTPUTS_BY_JOB = {
    "understand": (
        "knowledge-graph.json",
        "meta.json",
        "source-inventory.json",
        "fingerprints.json",
        "quality-report.json",
    ),
    "understand-domain": (
        "intermediate/domain-analysis.json",
        "domain-graph.json",
        "quality-report.json",
    ),
    "understand-knowledge": (
        "knowledge-graph.json",
        "meta.json",
        "source-inventory.json",
        "fingerprints.json",
        "quality-report.json",
    ),
}

RUNTIME_VALIDATED_JOB_KINDS = frozenset(REQUIRED_GRAPH_OUTPUTS_BY_JOB)

SUPPORTED_OUTPUT_LOCALES = {
    "zh-CN": "Simplified Chinese",
    "en-US": "English",
    "ru-RU": "Russian",
}

LANGUAGE_DIRECTIVE_TEMPLATE = (
    "Generate all user-visible textual content in {language}. "
    "Keep code identifiers, file paths, schema keys, tags, and established "
    "technical terms unchanged when appropriate."
)

ACTIVE_JOB_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.RUNNING,
    JobStatus.WAITING_CONFIRMATION,
}


class UnderstandAnythingRunner:
    def __init__(
        self,
        context: Context,
        config: dict[str, Any] | None = None,
        registry_path: str | Path | None = None,
    ) -> None:
        self.context = context
        self.config = config or {}
        self.host = AstrBotHostAdapter(context)
        self.github = GitHubRepoManager(
            git_timeout_seconds=self._coerce_positive_int(
                self.config.get("github_command_timeout_seconds"),
                DEFAULT_GIT_COMMAND_TIMEOUT_SECONDS,
            ),
        )
        self.security = PathSecurity(
            [],
            implicit_roots=[self.github.cache_root, self.github.artifact_root],
        )
        self.jobs = JobStore()
        self.runtime = UnderstandAnythingRuntime(
            auto_build=bool(self.config.get("auto_build", True)),
        )
        self.dispatcher = LLMDispatcher(
            context,
            str(self.config.get("provider_id") or ""),
        )
        self.subagent_provider_id = str(self.config.get("subagent_provider_id") or "")
        self.max_parallel_file_agents = self._coerce_positive_int(
            self.config.get("max_parallel_file_agents"),
            5,
        )
        self.max_parallel_article_agents = self._coerce_positive_int(
            self.config.get("max_parallel_article_agents"),
            3,
        )
        try:
            max_concurrent_jobs = int(self.config.get("max_concurrent_jobs") or 1)
        except (TypeError, ValueError):
            max_concurrent_jobs = 1
        self._job_semaphore = asyncio.Semaphore(max(1, max_concurrent_jobs))
        self._tasks: dict[str, asyncio.Task] = {}
        self._confirmation_futures: dict[str, asyncio.Future[str]] = {}
        self._chat_notification_keys: dict[str, set[str]] = {}
        self._auto_update_task: asyncio.Task | None = None
        self._auto_update_projects: set[Path] = set()
        self.registry = ProjectRegistry(Path(registry_path) if registry_path else None)

    async def initialize(self) -> None:
        interval = self._auto_update_poll_seconds(
            self.config.get("auto_update_poll_interval"),
        )
        if interval > 0:
            self._discover_auto_update_projects()
            self._auto_update_task = asyncio.create_task(
                self._auto_update_loop(interval),
            )

    async def terminate(self) -> None:
        if self._auto_update_task and not self._auto_update_task.done():
            self._auto_update_task.cancel()
        for task in self._tasks.values():
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    def project_store(
        self,
        project_path: str | Path | None = None,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> ProjectStore:
        if project_path is None:
            try:
                record = self.registry.resolve_record(
                    project_id=project_id,
                    project_name=project_name,
                    project_ref=project_ref,
                )
            except ProjectRegistryError:
                if project_ref and ProjectRegistry._looks_like_path(project_ref):
                    return ProjectStore(self.security.resolve_project_path(project_ref))
                raise
            source = record.source if isinstance(record.source, dict) else {}
            source_root = self.security.resolve_project_path(
                record.path,
                must_exist=source.get("type") != "github",
            )
            return ProjectStore(
                source_root,
                graph_root=Path(record.graph_root),
            )
        return ProjectStore(
            self.resolve_project_root(
                project_path=project_path,
                project_id=project_id,
                project_name=project_name,
                project_ref=project_ref,
            )
        )

    def resolve_project_root(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> Path:
        return self.registry.resolve(
            self.security,
            project_id=project_id,
            project_name=project_name,
            project_path=project_path,
            project_ref=project_ref,
        )

    async def ensure_project_source_ready(
        self,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> None:
        record = self.registry.resolve_record(
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        source = record.source if isinstance(record.source, dict) else {}
        if source.get("type") != "github":
            return
        source_root = Path(record.path)
        if source_root.is_dir():
            return
        has_target_url = bool(source.get("target_url"))
        ref = str(source.get("ref")) if source.get("ref") else None
        checkout = await self.github.resolve_remote(
            str(source.get("target_url") or source.get("repo_url") or ""),
            None if has_target_url else ref,
            self._source_github_proxy(source),
        )
        result = await self.github.prepare_with_checkout(checkout)
        self.registry.register(
            result.path,
            auto_update=record.auto_update,
            aliases=record.aliases,
            graph_root=result.checkout.graph_root,
            source=self._github_source_payload(result.checkout),
        )

    async def start_skill_job(
        self,
        *,
        skill_name: str,
        job_label: str = "analysis",
        raw_args: str = "",
        event: AstrMessageEvent | None = None,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        target: str | Path | None = None,
        repo_url: str | None = None,
        ref: str | None = None,
        github_proxy: str | None = None,
        flags: Sequence[str] | None = None,
        start_task: bool = True,
        locale: str | None = None,
    ) -> JobSnapshot:
        parsed = parse_job_args(raw_args)
        selected_flags = list(flags) if flags is not None else parsed.flags
        selected_github_proxy = github_proxy or parsed.github_proxy
        target_text = str(target).strip() if target is not None else ""
        if target_text:
            if GitHubRepoManager.is_http_url(target_text):
                repo_url = target_text
                project_path = None
            else:
                project_path = target_text
                repo_url = None
        effective_project_ref = project_ref or parsed.project_ref
        github_checkout = self._github_checkout_from_request(
            repo_url=repo_url,
            ref=ref or parsed.git_ref,
            parsed_path=parsed.path,
            github_proxy=selected_github_proxy,
        )
        if (
            github_checkout is None
            and repo_url is None
            and project_path is None
            and parsed.path is None
        ):
            github_checkout = self._github_checkout_from_registry(
                project_id=project_id,
                project_name=project_name,
                project_ref=effective_project_ref,
                github_proxy=selected_github_proxy,
            )
        if github_checkout:
            project_root = github_checkout.analysis_root
            graph_root = github_checkout.graph_root
        else:
            project_root = self._resolve_job_project_root(
                raw_args=raw_args,
                parsed_path=parsed.path,
                project_path=project_path,
                project_id=project_id,
                project_name=project_name,
                project_ref=effective_project_ref,
            )
            graph_root = project_root / ".understand-anything"
        display_args = raw_args.strip() or format_job_args(project_root, selected_flags)
        source_payload = (
            self._github_source_payload(github_checkout)
            if github_checkout
            else {"type": "local"}
        )
        project_display_name = self._initial_project_display_name(
            project_root,
            github_checkout,
        )
        status_ref = self._initial_status_ref(project_root, github_checkout)
        status_aliases = self._initial_status_aliases(project_root, github_checkout)
        auto_update = self._auto_update_setting_from_flags(selected_flags)
        job = self.jobs.create(
            skill_name,
            project_root,
            {
                "raw_args": display_args,
                "project_path": str(project_root),
                "project_display_name": project_display_name,
                "status_ref": status_ref,
                "status_aliases": status_aliases,
                "project_id": ProjectRegistry.project_id_for(
                    graph_root.parent if github_checkout else project_root,
                ),
                "graph_root": str(graph_root),
                "flags": selected_flags,
                "auto_update": auto_update,
                "locale": self._resolve_output_locale(locale, event),
                "source": source_payload,
                "job_label": job_label,
                "started_notification_sent": False,
            },
        )
        if not github_checkout:
            self._track_project_from_flags(project_root, selected_flags)
        self.registry.register(
            project_root,
            job_id=job.job_id,
            auto_update=auto_update,
            aliases=status_aliases,
            graph_root=graph_root,
            source=source_payload,
            status=(
                ProjectStatus.CLONING
                if github_checkout
                else ProjectStatus.ANALYZING
            ),
        )
        if start_task:
            job.args["started_notification_sent"] = await self._send_job_chat_message(
                job,
                event,
                self.format_job_source_started_message(job, job_label=job_label),
                key="progress:source",
            )
            task = asyncio.create_task(self._run_skill_job(job, event))
            self._tasks[job.job_id] = task
        return job

    async def chat(
        self,
        *,
        query: str,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        event: AstrMessageEvent | None = None,
        context_items: list[Any] | None = None,
        include_context: bool = False,
        locale: str | None = None,
    ) -> str | dict[str, Any]:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        assistant_bundle = await self._assistant_context_bundle(
            store,
            mode="chat",
            messages=[{"role": "user", "content": query}],
            context_items=context_items,
            locale=locale,
            event=event,
        )
        payload = await self.runtime.run_action(
            "chat_prompt",
            {
                "graph": graph,
                "query": query,
                **self._language_payload(locale, event),
            },
        )
        answer = await self.dispatcher.generate(
            prompt=self._prompt_with_assistant_context(
                assistant_bundle,
                str(payload["markdown"]),
            ),
            event=event,
            system_prompt=self._with_language_directive(
                "Answer using the provided Understand Anything graph context.",
                locale,
                event,
            ),
        )
        return self._assistant_response_payload(
            "answer",
            answer,
            assistant_bundle,
            include_context,
        )

    async def explain(
        self,
        *,
        target: str,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        event: AstrMessageEvent | None = None,
        context_items: list[Any] | None = None,
        include_context: bool = False,
        locale: str | None = None,
    ) -> str | dict[str, Any]:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        assistant_bundle = await self._assistant_context_bundle(
            store,
            mode="explain",
            messages=[{"role": "user", "content": f"Explain {target}"}],
            context_items=context_items,
            locale=locale,
            event=event,
        )
        payload = await self.runtime.run_action(
            "explain_prompt",
            {
                "graph": graph,
                "path": target,
                **self._language_payload(locale, event),
            },
        )
        answer = await self.dispatcher.generate(
            prompt=self._prompt_with_assistant_context(
                assistant_bundle,
                str(payload["markdown"]),
            ),
            event=event,
            system_prompt=self._with_language_directive(
                "Explain the requested component from the graph context.",
                locale,
                event,
            ),
        )
        return self._assistant_response_payload(
            "answer",
            answer,
            assistant_bundle,
            include_context,
        )

    async def diff(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        changed_files: list[str] | None = None,
        event: AstrMessageEvent | None = None,
        context_items: list[Any] | None = None,
        include_context: bool = False,
        locale: str | None = None,
    ) -> str | dict[str, Any]:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        files = changed_files or self._git_changed_files(store.project_root)
        assistant_bundle = await self._assistant_context_bundle(
            store,
            mode="diff",
            messages=[{"role": "user", "content": "Analyze diff impact."}],
            context_items=context_items,
            changed_files=files,
            locale=locale,
            event=event,
        )
        payload = await self.runtime.run_action(
            "diff_markdown",
            {
                "graph": graph,
                "changedFiles": files,
                **self._language_payload(locale, event),
            },
        )
        store.write_json(
            "diff-overlay.json",
            {
                "changedNodeIds": payload.get("changedNodeIds", []),
                "affectedNodeIds": payload.get("affectedNodeIds", []),
                "unmappedFiles": payload.get("unmappedFiles", []),
            },
        )
        answer = await self.dispatcher.generate(
            prompt=self._prompt_with_assistant_context(
                assistant_bundle,
                str(payload["markdown"]),
            ),
            event=event,
            system_prompt=self._with_language_directive(
                "Analyze diff impact and risks from the graph context.",
                locale,
                event,
            ),
        )
        return self._assistant_response_payload(
            "answer",
            answer,
            assistant_bundle,
            include_context,
        )

    async def onboard(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        event: AstrMessageEvent | None = None,
        context_items: list[Any] | None = None,
        include_context: bool = False,
        locale: str | None = None,
    ) -> str | dict[str, Any]:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        assistant_bundle = await self._assistant_context_bundle(
            store,
            mode="onboarding",
            messages=[{"role": "user", "content": "Generate onboarding guidance."}],
            context_items=context_items,
            locale=locale,
            event=event,
        )
        payload = await self.runtime.run_action(
            "onboard_markdown",
            {"graph": graph, **self._language_payload(locale, event)},
        )
        markdown = str(payload["markdown"])
        return self._assistant_response_payload(
            "markdown",
            markdown,
            assistant_bundle,
            include_context,
        )

    async def _assistant_context_bundle(
        self,
        store: ProjectStore,
        *,
        mode: str,
        messages: list[dict[str, str]],
        context_items: list[Any] | None = None,
        changed_files: list[str] | None = None,
        locale: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "projectRoot": str(store.project_root),
            "graphRoot": str(store.graph_root),
            "mode": mode,
            "messages": messages,
            **self._language_payload(locale, event),
        }
        if context_items is not None:
            payload["contextItems"] = context_items
        if changed_files is not None:
            payload["changedFiles"] = changed_files
        bundle = await self.runtime.run_action("assistant_context_bundle", payload)
        if not isinstance(bundle, dict):
            raise RuntimeError("assistant_context_bundle returned an invalid payload.")
        if bundle.get("ok") is False:
            message = str(bundle.get("message") or "assistant context build failed")
            raise RuntimeError(message)
        return bundle

    @staticmethod
    def _prompt_with_assistant_context(
        assistant_bundle: dict[str, Any],
        graph_prompt: str,
    ) -> str:
        assistant_prompt = str(assistant_bundle.get("prompt") or "").strip()
        graph_prompt = graph_prompt.strip()
        if assistant_prompt and graph_prompt:
            return f"{assistant_prompt}\n\n## Existing Graph Prompt\n{graph_prompt}"
        return assistant_prompt or graph_prompt

    @staticmethod
    def _assistant_response_payload(
        value_key: str,
        value: str,
        assistant_bundle: dict[str, Any],
        include_context: bool,
    ) -> str | dict[str, Any]:
        if not include_context:
            return value
        context = assistant_bundle.get("context")
        warnings = assistant_bundle.get("warnings")
        return {
            value_key: value,
            "assistantContext": context if isinstance(context, dict) else {},
            "assistantWarnings": warnings if isinstance(warnings, list) else [],
        }

    def format_job_started_message(
        self,
        job: JobSnapshot,
        *,
        job_label: str = "analysis",
    ) -> str:
        return self.format_job_source_started_message(job, job_label=job_label)

    def format_job_source_started_message(
        self,
        job: JobSnapshot,
        *,
        job_label: str = "analysis",
    ) -> str:
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        stage = self._source_stage_label(job, locale)
        status_command = self._status_command(job)
        label = self._job_label(job_label, locale)
        if locale == "en-US":
            return (
                f"Preparing source: {name}\n"
                f"Stage: {stage}\n"
                f"The {label} workflow will run after source preparation.\n"
                f"Progress: {status_command}"
            )
        if locale == "ru-RU":
            return (
                f"Подготовка исходного кода: {name}\n"
                f"Этап: {stage}\n"
                f"Процесс {label} продолжится после подготовки исходного кода.\n"
                f"Статус: {status_command}"
            )
        return (
            f"正在获取源码：{name}\n"
            f"阶段：{stage}\n"
            f"源码准备完成后将进入{label}流程。\n"
            f"查看进度：{status_command}"
        )

    def format_tool_job_submitted_message(self, job: JobSnapshot) -> str:
        if not job.args.get("started_notification_sent"):
            return self.format_job_source_started_message(
                job,
                job_label=str(job.args.get("job_label") or "analysis"),
            )
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        return self._localized(
            locale,
            zh=(
                f"内部状态：{name} 源码准备中；用户可见的源码准备通知已由插件发送。"
                "不要复述为分析正在运行。"
            ),
            en=(
                f"Internal status: source preparation for {name} is in progress; "
                "the plugin already sent the user-facing source preparation "
                "notification. Do not describe the analysis as running."
            ),
            ru=(
                f"Внутренний статус: идет подготовка исходного кода для {name}; "
                "плагин уже отправил пользователю уведомление о подготовке "
                "исходного кода. Не описывайте анализ как выполняющийся."
            ),
        )

    def format_job_status(self, project_ref: str | None = None) -> str:
        job, ambiguous = self._select_status_job(project_ref)
        locale = self._resolve_output_locale()
        normalized_ref = str(project_ref or "").strip()
        if ambiguous:
            return self._format_ambiguous_status_ref(normalized_ref, ambiguous, locale)
        if job is None:
            if normalized_ref:
                return self._format_status_not_found(normalized_ref, locale)
            return self._localized(
                locale,
                zh="当前会话没有 Understand Anything 分析任务。",
                en="No Understand Anything analysis jobs are available in this session.",
                ru="В этом сеансе нет задач анализа Understand Anything.",
            )

        locale = self._job_locale(job)
        name = self._job_display_name(job)
        progress = job.progress
        failed_step = str(job.args.get("failed_step") or "").strip()
        failed_phase = str(job.args.get("failed_phase") or progress.phase).strip()
        title = (
            self._localized(
                locale,
                zh=f"分析失败：{name}",
                en=f"Analysis failed: {name}",
                ru=f"Анализ завершился ошибкой: {name}",
            )
            if job.status is JobStatus.FAILED
            else self._localized(
                locale,
                zh=f"分析状态：{name}",
                en=f"Analysis status: {name}",
                ru=f"Статус анализа: {name}",
            )
        )
        lines = [
            title,
            self._localized(
                locale,
                zh=f"状态：{self._status_label(job.status, locale)}",
                en=f"Status: {self._status_label(job.status, locale)}",
                ru=f"Статус: {self._status_label(job.status, locale)}",
            ),
            self._localized(
                locale,
                zh=(
                    f"进度：{progress.percent}% - "
                    f"{self._phase_label(progress.phase, locale)}"
                ),
                en=(
                    f"Progress: {progress.percent}% - "
                    f"{self._phase_label(progress.phase, locale)}"
                ),
                ru=(
                    f"Прогресс: {progress.percent}% - "
                    f"{self._phase_label(progress.phase, locale)}"
                ),
            ),
            self._localized(
                locale,
                zh=f"阶段：{self._format_progress_step(progress.steps, locale)}",
                en=f"Step: {self._format_progress_step(progress.steps, locale)}",
                ru=f"Этап: {self._format_progress_step(progress.steps, locale)}",
            ),
            self._localized(
                locale,
                zh=f"项目路径：{job.project_root}",
                en=f"Project path: {job.project_root}",
                ru=f"Путь проекта: {job.project_root}",
            ),
            self._localized(
                locale,
                zh=f"更新时间：{self._format_timestamp(job.updated_at)}",
                en=f"Updated: {self._format_timestamp(job.updated_at)}",
                ru=f"Обновлено: {self._format_timestamp(job.updated_at)}",
            ),
        ]
        if job.status is JobStatus.WAITING_CONFIRMATION:
            lines.append(
                self._localized(
                    locale,
                    zh="操作：回复 `继续` / `取消`，或更新 .understandignore 规则。",
                    en=(
                        "Action: reply `continue` / `cancel`, or update "
                        ".understandignore rules."
                    ),
                    ru=(
                        "Действие: ответьте `continue` / `cancel` или обновите "
                        "правила .understandignore."
                    ),
                )
            )
        if job.error and failed_step:
            lines.append(
                self._localized(
                    locale,
                    zh=(f"失败阶段：{self._phase_label(failed_phase, locale)}"),
                    en=f"Failed step: {self._phase_label(failed_phase, locale)}",
                    ru=f"Сбой на этапе: {self._phase_label(failed_phase, locale)}",
                )
            )
        if job.error:
            lines.append(
                self._localized(
                    locale,
                    zh=f"原因：{self._truncate_status_text(job.error)}",
                    en=f"Error: {self._truncate_status_text(job.error)}",
                    ru=f"Ошибка: {self._truncate_status_text(job.error)}",
                )
            )
            hint = self._github_failure_retry_hint(job, locale)
            if hint:
                lines.append(
                    self._localized(
                        locale,
                        zh=f"重试：{hint}",
                        en=f"Next: {hint}",
                        ru=f"Далее: {hint}",
                    )
                )
        elif job.status is JobStatus.FINISHED:
            lines.append(
                self._localized(
                    locale,
                    zh="结果：分析已完成。",
                    en="Result: analysis finished.",
                    ru="Результат: анализ завершен.",
                )
            )
        return "\n".join(lines)

    async def _run_skill_job(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
    ) -> None:
        agent_event = event or self._synthetic_event(job)
        try:
            self.jobs.mark_running(job.job_id)
            await self._set_job_progress(
                job,
                event,
                job.job_id,
                "source",
                "Preparing project source.",
                15,
            )
            self.jobs.append_log(
                job.job_id,
                f"Starting {job.kind} job.",
            )
            await self._prepare_job_source(job, event)
            self.jobs.append_log(job.job_id, f"Target project root: {job.project_root}")
            self._ensure_graph_root_defaults(job)
            self._update_project_status_for_job(
                job,
                ProjectStatus.ANALYZING,
                current_job_id=job.job_id,
            )

            async with self._job_semaphore:
                self.jobs.mark_running(job.job_id)
                ensure_computer_use_enabled(
                    self.context,
                    umo=getattr(event, "unified_msg_origin", None) if event else None,
                )
                await self._set_job_progress(
                    job,
                    event,
                    job.job_id,
                    "runtime",
                    "Preparing bundled runtime.",
                    30,
                )
                await self.runtime.ensure_ready()
                if job.kind in RUNTIME_VALIDATED_JOB_KINDS:
                    await self._run_runtime_validation_action(
                        job,
                        "preflight_inventory",
                    )
                prompt = self._build_skill_execution_prompt(job)
                subagent_dispatcher = UnderstandAnythingSubAgentDispatcher(
                    self.context,
                    log_fn=lambda message: self.jobs.append_log(job.job_id, message),
                )
                if job.kind in {
                    "understand",
                    "understand-domain",
                    "understand-knowledge",
                }:
                    status = UnderstandAnythingSubAgentRegistry(
                        self.context,
                        self.config,
                    ).status_payload()
                    if not status.get("ready"):
                        blocked_roles = sorted(
                            set(status.get("missing_roles", []))
                            | set(status.get("stale_roles", []))
                            | set(status.get("unloaded_roles", []))
                        )
                        blocked_text = ", ".join(blocked_roles) or str(
                            status.get("error") or "unknown"
                        )
                        raise RuntimeError(
                            "Understand Anything SubAgents are not ready. "
                            "Open the plugin Dashboard and run UA SubAgents "
                            "registration. "
                            f"Blocked roles: {blocked_text}",
                        )
                    subagent_dispatcher.ensure_ready()
                await self._set_job_progress(
                    job,
                    event,
                    job.job_id,
                    "agent",
                    "Running Understand Anything agent workflow.",
                    55,
                )
                result = await self.dispatcher.run_with_local_tools(
                    event=agent_event,
                    prompt=prompt,
                    system_prompt=(
                        "You are the AstrBot host adapter for Understand Anything. "
                        "Execute the bundled Understand Anything skill faithfully "
                        "with local tools. "
                        "When a workflow needs a project-scanner, file-analyzer, "
                        "assemble-reviewer, architecture-analyzer, tour-builder, "
                        "graph-reviewer, domain-analyzer, or article-analyzer role, "
                        "you MUST call the internal UA SubAgent tools instead of "
                        "performing that worker role yourself. "
                        "Do not modify AstrBot source files or plugin runtime source. "
                        "Only write analysis outputs under the UA graph output root "
                        "provided in the execution prompt."
                    ),
                    max_steps=120,
                    extra_tools=subagent_dispatcher.tool_set(),
                )
                self.jobs.append_log(job.job_id, "Agent workflow finished.")
                await self._set_job_progress(
                    job,
                    event,
                    job.job_id,
                    "validate",
                    "Validating generated graph outputs.",
                    85,
                )
                if job.kind in RUNTIME_VALIDATED_JOB_KINDS:
                    await self._run_runtime_validation_action(
                        job,
                        self._runtime_output_action(job),
                    )
                self._validate_required_outputs(job)
                self.jobs.mark_finished(job.job_id, {"message": result})
                self.registry.register(
                    job.project_root,
                    job_id=job.job_id,
                    auto_update=(
                        job.args.get("auto_update")
                        if isinstance(job.args.get("auto_update"), bool)
                        else None
                    ),
                    aliases=self._job_source_aliases(job),
                    graph_root=job.args.get("graph_root"),
                    source=(
                        job.args.get("source")
                        if isinstance(job.args.get("source"), dict)
                        else None
                    ),
                    status=ProjectStatus.READY,
                )
                graph_counts = self._job_graph_counts(job)
                self._update_project_status_for_job(
                    job,
                    ProjectStatus.READY,
                    current_job_id=None,
                    last_job_id=job.job_id,
                    node_count=graph_counts[0],
                    edge_count=graph_counts[1],
                )
                if event is not None:
                    await self._send_job_chat_message(
                        job,
                        event,
                        self._format_job_finished_message(job),
                        key="finished",
                    )
        except asyncio.CancelledError:
            self.jobs.mark_cancelled(job.job_id)
            raise
        except Exception as exc:
            logger.error("Understand Anything job failed: %s", exc)
            failed_step = job.progress.label
            failed_phase = job.progress.phase
            job.args["failed_step"] = failed_step
            job.args["failed_phase"] = failed_phase
            self.jobs.mark_failed(job.job_id, str(exc))
            self._update_project_status_for_job(
                job,
                ProjectStatus.FAILED,
                current_job_id=None,
                last_job_id=job.job_id,
                last_error=str(exc),
            )
            if event is not None:
                await self._send_job_chat_message(
                    job,
                    event,
                    self._format_job_failed_message(job, str(exc), failed_step),
                    key="failed",
                )
        finally:
            self._cleanup_github_cache_after_job(job)

    async def _set_job_progress(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
        job_id: str,
        phase: str,
        label: str,
        percent: int,
    ) -> None:
        self.jobs.set_progress(job_id, phase, label, percent)
        self.jobs.append_observation(
            job_id,
            kind="validation" if phase == "validate" else "stage",
            level="info",
            title=label,
            message=label,
            stage=phase,
            status="running",
            observation_id=f"stage-{phase}",
        )
        notification = self._format_job_progress_message(job, phase)
        if notification is None:
            return
        key, message = notification
        await self._send_job_chat_message(job, event, message, key=key)

    async def _send_job_chat_message(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
        message: str,
        *,
        key: str,
    ) -> bool:
        if event is None:
            return False
        notified = self._chat_notification_keys.setdefault(job.job_id, set())
        if key in notified:
            return True
        chain = MessageChain().message(message)
        try:
            sent = await self.host.send_message(event, chain)
        except Exception as exc:
            logger.warning(
                "Understand Anything proactive chat notification failed: %s",
                exc,
            )
            with contextlib.suppress(Exception):
                self.jobs.append_log(
                    job.job_id,
                    f"Proactive chat notification failed: {exc}",
                )
            return False
        if sent:
            notified.add(key)
            return True
        logger.warning(
            "Understand Anything chat notification skipped: proactive send is unavailable."
        )
        try:
            self.jobs.append_log(
                job.job_id,
                "Chat notification skipped: proactive send is unavailable.",
            )
        except Exception as exc:
            logger.warning("Understand Anything chat notification log failed: %s", exc)
        return False

    def _format_job_progress_message(
        self,
        job: JobSnapshot,
        phase: str,
    ) -> tuple[str, str] | None:
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        if phase == "source":
            return (
                "progress:source",
                self.format_job_source_started_message(
                    job,
                    job_label=str(job.args.get("job_label") or "analysis"),
                ),
            )
        if phase == "confirmation":
            message = self._localized(
                locale,
                zh=(
                    f"需要确认扫描范围：{name}\n"
                    "回复：继续 / 取消，或更新 .understandignore 规则。"
                ),
                en=(
                    f"Scan scope needs confirmation: {name}\n"
                    "Reply: continue / cancel, or update .understandignore rules."
                ),
                ru=(
                    f"Нужно подтвердить область сканирования: {name}\n"
                    "Ответьте: continue / cancel или обновите .understandignore."
                ),
            )
            return "progress:confirmation", message
        if phase == "agent":
            message = self._localized(
                locale,
                zh=f"开始生成图谱：{name}\n这一步可能需要较长时间。",
                en=f"Generating graph: {name}\nThis step can take a while.",
                ru=(
                    f"Построение графа: {name}\n"
                    "Этот этап может занять продолжительное время."
                ),
            )
            return "progress:agent", message
        return None

    def _format_job_finished_message(self, job: JobSnapshot) -> str:
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        project_ref = self._command_status_ref(job)
        return self._localized(
            locale,
            zh=(
                f"分析完成：{name}\n"
                f"可以使用 /understand chat --project {project_ref} <问题>"
            ),
            en=(
                f"Analysis finished: {name}\n"
                f"Ask questions with /understand chat --project {project_ref} <query>"
            ),
            ru=(
                f"Анализ завершен: {name}\n"
                f"Задавайте вопросы: /understand chat --project {project_ref} <вопрос>"
            ),
        )

    def _format_job_failed_message(
        self,
        job: JobSnapshot,
        error: str,
        failed_step: str,
    ) -> str:
        snapshot = self.jobs.get(job.job_id) or job
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        phase = str(job.args.get("failed_phase") or snapshot.progress.phase)
        lines = [
            self._localized(
                locale,
                zh=f"分析失败：{name}",
                en=f"Analysis failed: {name}",
                ru=f"Анализ завершился ошибкой: {name}",
            ),
            self._localized(
                locale,
                zh=f"阶段：{self._phase_label(phase, locale)}",
                en=(
                    "Step: "
                    f"{self._phase_label(phase, locale) or failed_step or snapshot.progress.label}"
                ),
                ru=f"Этап: {self._phase_label(phase, locale)}",
            ),
            self._localized(
                locale,
                zh=f"原因：{self._truncate_status_text(error)}",
                en=f"Error: {self._truncate_status_text(error)}",
                ru=f"Ошибка: {self._truncate_status_text(error)}",
            ),
            self._localized(
                locale,
                zh=f"查看进度：{self._status_command(job)}",
                en=f"Status: {self._status_command(job)}",
                ru=f"Статус: {self._status_command(job)}",
            ),
        ]
        hint = self._github_failure_retry_hint(job, locale)
        if hint:
            lines.append(
                self._localized(
                    locale,
                    zh=f"重试：{hint}",
                    en=f"Next: {hint}",
                    ru=f"Далее: {hint}",
                )
            )
        return "\n".join(lines)

    def _github_failure_retry_hint(
        self,
        job: JobSnapshot,
        locale: str | None = None,
    ) -> str:
        source = job.args.get("source")
        if not isinstance(source, dict) or source.get("type") != "github":
            return ""
        target = str(source.get("target_url") or source.get("repo_url") or "").strip()
        if not target:
            return ""
        selected_locale = locale or self._job_locale(job)
        return self._localized(
            selected_locale,
            zh="已自动尝试直连 GitHub 和内置代理预设；请稍后重试，或在 Dashboard 查看任务日志确认网络状态。",
            en=(
                "Direct GitHub and bundled proxy presets were tried automatically; "
                "retry later or check the Dashboard job logs for network details."
            ),
            ru=(
                "Прямой доступ к GitHub и встроенные proxy уже были проверены; "
                "повторите позже или проверьте журналы задачи в Dashboard."
            ),
        )

    def _build_skill_execution_prompt(self, job: JobSnapshot) -> str:
        skill_dir = PLUGIN_SKILLS_ROOT / job.kind
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            raise FileNotFoundError(
                f"Bundled Understand Anything skill not found: {skill_md}"
            )

        agent_files = sorted(AGENT_PROMPTS_ROOT.glob("*.md"))
        agent_index = "\n".join(f"- {path.name}: {path}" for path in agent_files)
        command_name = SKILL_COMMANDS.get(job.kind, job.kind)
        language_directive = self._language_directive_for_job(job)
        return (
            f"Execute Understand Anything command `/{command_name}` with arguments:\n"
            f"{job.args.get('raw_args', '')}\n\n"
            f"Target project root (source files):\n{job.project_root}\n\n"
            f"UA graph output root:\n{job.args.get('graph_root', job.project_root / '.understand-anything')}\n\n"
            "Bundled Understand Anything skill instructions:\n"
            "```markdown\n"
            f"{read_prompt_file(skill_md)}\n"
            "```\n\n"
            "Available AstrBot agent prompt files:\n"
            f"{agent_index}\n\n"
            "Important AstrBot host rules:\n"
            f"- {language_directive}\n"
            "- Perform only the supervisor/orchestration work directly in this agent session.\n"
            "- When the skill says to run an agent role, call `ua_run_subagent_role` "
            "or `ua_run_subagent_batches`; do not execute worker roles yourself.\n"
            "- Use `ua_run_subagent_batches` for file-analyzer batches with "
            f"`max_concurrency={self.max_parallel_file_agents}`.\n"
            "- Use `ua_run_subagent_batches` for article-analyzer batches with "
            f"`max_concurrency={self.max_parallel_article_agents}`.\n"
            "- Use absolute paths shown above. The plugin runtime root is "
            "`understand-anything/`, skills live in root `skills/`, and prompts "
            "live in `astrbot_adapter/prompts/agents/`.\n"
            "- Set `PROJECT_ROOT` to the target project root above.\n"
            "- Set `UA_GRAPH_ROOT` to the UA graph output root above.\n"
            "- Treat every `$PROJECT_ROOT/.understand-anything` path in bundled "
            "skills, scripts, and agent prompts as `$UA_GRAPH_ROOT` for this run. "
            "Use `$PROJECT_ROOT` only for reading source files and git state.\n"
            "- Write graph files, meta, fingerprints, config, intermediate, and "
            "tmp outputs under `$UA_GRAPH_ROOT`.\n"
            "- Do not pause for `.understandignore` review or confirmation. "
            "Use existing `$UA_GRAPH_ROOT/.understandignore` or project-root "
            "`.understandignore` files if present; otherwise continue with the "
            "bundled default ignore rules.\n"
            "- Preserve Understand Anything JSON schema and Dashboard compatibility.\n"
        )

    @classmethod
    def _normalize_locale(cls, locale: str | None) -> str | None:
        value = str(locale or "").strip().replace("_", "-").lower()
        if not value:
            return None
        if value.startswith("zh"):
            return "zh-CN"
        if value.startswith("en"):
            return "en-US"
        if value.startswith("ru"):
            return "ru-RU"
        return None

    @classmethod
    def _language_name_for_locale(cls, locale: str) -> str:
        return SUPPORTED_OUTPUT_LOCALES.get(locale, SUPPORTED_OUTPUT_LOCALES["zh-CN"])

    @classmethod
    def _language_directive_for_locale(cls, locale: str) -> str:
        return LANGUAGE_DIRECTIVE_TEMPLATE.format(
            language=cls._language_name_for_locale(locale),
        )

    def _resolve_output_locale(
        self,
        locale: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> str:
        configured = str(self.config.get("output_locale") or "auto").strip()
        configured_locale = self._normalize_locale(configured)
        if configured_locale and configured.lower() != "auto":
            return configured_locale
        return (
            self._normalize_locale(locale)
            or self._infer_locale_from_event(event)
            or "zh-CN"
        )

    def _language_payload(
        self,
        locale: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> dict[str, str]:
        resolved_locale = self._resolve_output_locale(locale, event)
        target_language = self._language_name_for_locale(resolved_locale)
        return {
            "locale": resolved_locale,
            "targetLanguage": target_language,
            "languageDirective": self._language_directive_for_locale(resolved_locale),
        }

    def _with_language_directive(
        self,
        system_prompt: str,
        locale: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> str:
        resolved_locale = self._resolve_output_locale(locale, event)
        return (
            f"{system_prompt}\n\n{self._language_directive_for_locale(resolved_locale)}"
        )

    def _language_directive_for_job(self, job: JobSnapshot) -> str:
        locale = self._resolve_output_locale(
            str(job.args.get("locale") or "") or None,
        )
        return self._language_directive_for_locale(locale)

    @classmethod
    def _infer_locale_from_event(cls, event: AstrMessageEvent | None) -> str | None:
        if event is None:
            return None
        message = ""
        get_message_str = getattr(event, "get_message_str", None)
        if callable(get_message_str):
            try:
                message = str(get_message_str() or "")
            except Exception:
                message = ""
        if not message:
            message = str(getattr(event, "message_str", "") or "")
        if any("\u4e00" <= char <= "\u9fff" for char in message):
            return "zh-CN"
        if any("\u0400" <= char <= "\u04ff" for char in message):
            return "ru-RU"
        if any(
            ("a" <= char.lower() <= "z") for char in cls._locale_signal_text(message)
        ):
            return "en-US"
        return None

    @classmethod
    def _locale_signal_text(cls, message: str) -> str:
        text = re.sub(r"https?://\S+", " ", message, flags=re.IGNORECASE)
        text = re.sub(r"[A-Za-z]:[\\/]\S+", " ", text)
        text = re.sub(
            r"(?<!\S)/(?:understand|ua_[\w-]+)\b", " ", text, flags=re.IGNORECASE
        )
        text = re.sub(r"\bua_[\w-]+\b", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"\b[\w-]+\s*=", " ", text)
        text = re.sub(r"--[\w-]+(?:=(?:\S+))?", " ", text)
        text = re.sub(
            r"\b[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\b", " ", text
        )
        words = re.findall(r"[A-Za-z][A-Za-z']*", text)
        ignored_words = {
            "understand",
            "analyze",
            "analysis",
            "status",
            "dashboard",
            "chat",
            "diff",
            "domain",
            "explain",
            "knowledge",
            "onboard",
            "github",
            "repo",
            "repository",
            "project",
            "start",
            "tool",
            "call",
            "target",
            "url",
            "ref",
            "path",
            "proxy",
        }
        return " ".join(
            word
            for word in words
            if word.casefold() not in ignored_words
            and not cls._looks_like_code_identifier(word)
        )

    @staticmethod
    def _looks_like_code_identifier(word: str) -> bool:
        if any(char.isdigit() for char in word):
            return True
        if word.isupper() and len(word) > 1:
            return True
        return any(char.isupper() for char in word[1:]) and any(
            char.islower() for char in word
        )

    async def _confirm_understandignore(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
        timeout_seconds: int = 600,
    ) -> bool:
        graph_root = self._job_graph_root(job)
        confirmation = build_ignore_confirmation(
            job.project_root,
            graph_root,
            timeout_seconds=timeout_seconds,
        )
        self.jobs.mark_waiting_confirmation(job.job_id, confirmation)
        self.jobs.append_log(job.job_id, "Waiting for .understandignore confirmation.")
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        self._confirmation_futures[job.job_id] = future
        try:
            if event is not None:
                await self._wait_for_message_confirmation(job, event, timeout_seconds)
            else:
                await self._wait_for_dashboard_confirmation(job, timeout_seconds)
        except TimeoutError:
            self.jobs.mark_cancelled(
                job.job_id, "Understand ignore confirmation timed out."
            )
            return False
        finally:
            self._confirmation_futures.pop(job.job_id, None)

        snapshot = self.jobs.get(job.job_id)
        if snapshot is None or snapshot.status is not JobStatus.QUEUED:
            return False
        return True

    async def _wait_for_dashboard_confirmation(
        self,
        job: JobSnapshot,
        timeout_seconds: int,
    ) -> None:
        future = self._confirmation_futures[job.job_id]
        await asyncio.wait_for(future, timeout_seconds)

    async def _wait_for_message_confirmation(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent,
        timeout_seconds: int,
    ) -> None:
        from astrbot.core.utils.session_waiter import SessionController, session_waiter

        @session_waiter(timeout_seconds)
        async def waiter(
            controller: SessionController,
            reply_event: AstrMessageEvent,
        ) -> None:
            reply_text = str(getattr(reply_event, "message_str", "") or "")
            action, _payload = parse_confirmation_reply(reply_text)
            if action == "unknown":
                await reply_event.send(
                    MessageChain().message(
                        self._confirmation_fallback_message(job, reply_text),
                    ),
                )
                controller.keep(timeout_seconds, reset_timeout=True)
                reply_event.stop_event()
                return
            snapshot = self.confirm_job_from_message(
                job.job_id,
                reply_text,
                source="conversation",
            )
            if action == "update":
                await reply_event.send(
                    MessageChain().message(
                        self._confirmation_message(job)
                        + "\n\n"
                        + self._localized(
                            self._job_locale(job),
                            zh="规则已更新。回复 `继续` 开始分析，或继续发送 `排除 ...` / `包含 ...`。",
                            en=(
                                "Rules updated. Reply `continue` to start analysis, "
                                "or keep sending `exclude ...` / `include ...`."
                            ),
                            ru=(
                                "Правила обновлены. Ответьте `continue`, чтобы начать "
                                "анализ, или продолжайте отправлять `exclude ...` / "
                                "`include ...`."
                            ),
                        )
                    ),
                )
                controller.keep(timeout_seconds, reset_timeout=True)
                reply_event.stop_event()
                return
            if snapshot.status is JobStatus.CANCELLED:
                await reply_event.send(
                    MessageChain().message(
                        self._localized(
                            self._job_locale(job),
                            zh="已取消 Understand Anything 分析。",
                            en="Understand Anything analysis cancelled.",
                            ru="Анализ Understand Anything отменен.",
                        )
                    )
                )
            else:
                await reply_event.send(
                    MessageChain().message(
                        self._localized(
                            self._job_locale(job),
                            zh="已确认，开始分析。",
                            en="Confirmed. Starting analysis.",
                            ru="Подтверждено. Анализ начинается.",
                        )
                    )
                )
            controller.stop()
            reply_event.stop_event()

        waiter_task = asyncio.create_task(waiter(event))
        await asyncio.sleep(0)
        await self._send_job_chat_message(
            job,
            event,
            self._confirmation_message(job),
            key="confirmation:understandignore",
        )
        await waiter_task

    def _confirmation_message(self, job: JobSnapshot) -> str:
        snapshot = self.jobs.get(job.job_id)
        confirmation = snapshot.confirmation if snapshot else None
        if not confirmation:
            return self._localized(
                self._job_locale(job),
                zh=f"扫描范围确认：{self._job_display_name(job)}",
                en=f"Confirm scan scope: {self._job_display_name(job)}",
                ru=f"Подтвердите область сканирования: {self._job_display_name(job)}",
            )
        summary = confirmation.get("summary", {})
        detected_dirs = ", ".join(summary.get("detected_dirs", [])) or "none"
        gitignore_count = len(summary.get("gitignore_patterns", []))
        locale = self._job_locale(job)
        name = self._job_display_name(job)
        exclusion_tree = self._confirmation_exclusion_tree(confirmation, locale)
        return self._localized(
            locale,
            zh=(
                f"扫描范围确认：{name}\n"
                f"建议排除目录：{detected_dirs}\n"
                f"已采纳 .gitignore 建议：{gitignore_count} 条\n"
                f"{exclusion_tree}\n"
                f"查看进度：{self._status_command(job)}\n\n"
                "回复 `继续` 开始分析，回复 `取消` 停止。\n"
                "需要调整范围时，发送 `排除 tests/ docs/` 或 `包含 dist/`。"
            ),
            en=(
                f"Scan scope confirmation: {name}\n"
                f"Suggested excluded directories: {detected_dirs}\n"
                f".gitignore suggestions applied: {gitignore_count}\n"
                f"{exclusion_tree}\n"
                f"Progress: {self._status_command(job)}\n\n"
                "Reply `continue` to start analysis, or `cancel` to stop.\n"
                "To adjust scope, send `exclude tests/ docs/` or `include dist/`."
            ),
            ru=(
                f"Подтверждение области сканирования: {name}\n"
                f"Рекомендуемые исключения: {detected_dirs}\n"
                f"Применено правил из .gitignore: {gitignore_count}\n"
                f"{exclusion_tree}\n"
                f"Статус: {self._status_command(job)}\n\n"
                "Ответьте `continue`, чтобы начать анализ, или `cancel`, чтобы "
                "остановить.\nДля изменения области отправьте `exclude tests/ docs/` "
                "или `include dist/`."
            ),
        )

    def _confirmation_exclusion_tree(
        self,
        confirmation: dict[str, Any],
        locale: str,
    ) -> str:
        summary = confirmation.get("summary", {})
        exclusions = summary.get("current_exclusions")
        if not isinstance(exclusions, dict):
            exclusions = {}
        directories = [
            str(item).strip().replace("\\", "/").strip("/")
            for item in exclusions.get("directories", [])
            if str(item).strip()
        ]
        heading = self._localized(
            locale,
            zh="当前排除目录树：",
            en="Current excluded directory tree:",
            ru="Текущее дерево исключенных каталогов:",
        )
        if not directories:
            empty = self._localized(
                locale,
                zh="暂无匹配到的目录。",
                en="no matching directories.",
                ru="нет совпадающих каталогов.",
            )
            return f"{heading}{empty}"
        lines = [heading, *self._directory_tree_lines(directories)]
        truncated = int(exclusions.get("truncated") or 0)
        if truncated > 0:
            lines.append(
                self._localized(
                    locale,
                    zh=f"... 还有 {truncated} 个目录未显示",
                    en=f"... {truncated} more directories not shown",
                    ru=f"... еще каталогов не показано: {truncated}",
                )
            )
        return "\n".join(lines)

    @staticmethod
    def _directory_tree_lines(paths: list[str]) -> list[str]:
        tree: dict[str, dict[str, Any]] = {}
        for path in paths:
            node = tree
            for segment in [part for part in path.split("/") if part]:
                node = node.setdefault(segment, {})

        lines: list[str] = []

        def walk(node: dict[str, dict[str, Any]], depth: int) -> None:
            for name in sorted(node, key=str.casefold):
                lines.append(f"{'  ' * depth}- {name}/")
                walk(node[name], depth + 1)

        walk(tree, 0)
        return lines

    def _confirmation_fallback_message(self, job: JobSnapshot, message: str) -> str:
        locale = self._job_locale(job)
        if self._status_command_requested(message):
            project_ref = self._status_ref_from_command(message)
            return self.format_job_status(project_ref or self._status_ref_for_job(job))
        if self._is_status_query(message):
            return (
                self.format_job_status(self._status_ref_for_job(job))
                + "\n\n"
                + self._localized(
                    locale,
                    zh="当前仍在等待扫描范围确认。回复 `继续` 开始分析，或 `取消` 停止。",
                    en=(
                        "The job is still waiting for scan scope confirmation. "
                        "Reply `continue` to start analysis, or `cancel` to stop."
                    ),
                    ru=(
                        "Задача ожидает подтверждения области сканирования. "
                        "Ответьте `continue`, чтобы начать, или `cancel`, чтобы "
                        "остановить."
                    ),
                )
            )
        return self._localized(
            locale,
            zh=(
                "当前需要先确认扫描范围。\n"
                "可回复：`继续`、`取消`、`排除 tests/ docs/`、`包含 dist/`。\n"
                "查看进度可以直接问“进度怎么样”。"
            ),
            en=(
                "Please confirm the scan scope first.\n"
                "You can reply: `continue`, `cancel`, `exclude tests/ docs/`, "
                "`include dist/`.\n"
                "Ask `status?` to check progress."
            ),
            ru=(
                "Сначала подтвердите область сканирования.\n"
                "Можно ответить: `continue`, `cancel`, `exclude tests/ docs/`, "
                "`include dist/`.\n"
                "Спросите `status?`, чтобы проверить прогресс."
            ),
        )

    @staticmethod
    def _is_status_query(message: str) -> bool:
        text = str(message or "").strip().casefold()
        if not text:
            return False
        if any(
            keyword in text
            for keyword in (
                "进度",
                "状态",
                "到哪",
                "推进",
                "下载",
                "卡住",
                "好了没",
                "完成了吗",
                "status",
                "progress",
                "running",
            )
        ):
            return True
        return False

    @staticmethod
    def _status_command_requested(message: str) -> bool:
        text = str(message or "").strip().casefold()
        return text.startswith(("/understand status", "understand status"))

    @staticmethod
    def _status_ref_from_command(message: str) -> str | None:
        text = str(message or "").strip()
        for prefix in ("/understand status", "understand status"):
            if text.casefold().startswith(prefix):
                return text[len(prefix) :].strip() or None
        return None

    def confirm_job(
        self,
        job_id: str,
        *,
        action: str,
        content: str | None = None,
        source: str = "dashboard",
    ) -> JobSnapshot:
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(f"Unknown job id: {job_id}")
        if job.status is not JobStatus.WAITING_CONFIRMATION or not job.confirmation:
            raise ValueError("Job is not waiting for confirmation.")
        graph_root = self._job_graph_root(job)
        normalized = str(action or "").strip().casefold()
        if normalized == "update":
            if content is None:
                raise ValueError("Missing confirmation content.")
            updated = write_ignore_content(graph_root, content)
            confirmation = build_ignore_confirmation(job.project_root, graph_root)
            confirmation["content"] = updated
            confirmation["source"] = source
            self.jobs.mark_waiting_confirmation(job_id, confirmation)
            self.jobs.append_log(job_id, f".understandignore updated from {source}.")
            return self.jobs._require(job_id)
        if normalized == "cancel":
            self.jobs.mark_cancelled(
                job_id, "User cancelled .understandignore confirmation."
            )
            self._resolve_confirmation(job_id, "cancel")
            return self.jobs._require(job_id)
        if normalized == "continue":
            if content is not None:
                write_ignore_content(graph_root, content)
            self.jobs.clear_confirmation(job_id)
            self.jobs.mark_queued(job_id)
            self.jobs.append_log(job_id, f".understandignore confirmed from {source}.")
            self._resolve_confirmation(job_id, "continue")
            return self.jobs._require(job_id)
        raise ValueError(f"Unsupported confirmation action: {action}")

    def confirm_job_from_message(
        self,
        job_id: str,
        message: str,
        *,
        source: str,
    ) -> JobSnapshot:
        action, content = apply_confirmation_reply(
            self._job_graph_root(self.jobs._require(job_id)), message
        )
        if action == "update":
            confirmation = build_ignore_confirmation(
                self.jobs._require(job_id).project_root,
                self._job_graph_root(self.jobs._require(job_id)),
            )
            confirmation["content"] = content
            confirmation["source"] = source
            self.jobs.mark_waiting_confirmation(job_id, confirmation)
            self.jobs.append_log(job_id, f".understandignore updated from {source}.")
            return self.jobs._require(job_id)
        return self.confirm_job(job_id, action=action, source=source)

    def _resolve_confirmation(self, job_id: str, value: str) -> None:
        future = self._confirmation_futures.get(job_id)
        if future is not None and not future.done():
            future.set_result(value)

    def _ensure_graph_root_defaults(self, job: JobSnapshot) -> None:
        graph_root = self._job_graph_root(job)
        graph_root.mkdir(parents=True, exist_ok=True)

    async def _run_runtime_validation_action(
        self,
        job: JobSnapshot,
        action: str,
    ) -> dict[str, Any]:
        result = await self.runtime.run_action(
            action,
            self._runtime_validation_payload(job),
        )
        self._append_runtime_observations(job, action, result)
        if result.get("ok") is False:
            fatal = result.get("fatal") or result.get("error")
            raise RuntimeError(
                str(fatal)
                if fatal
                else f"Understand Anything runtime action failed: {action}",
            )
        return result

    def _runtime_validation_payload(self, job: JobSnapshot) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "projectRoot": str(job.project_root),
            "graphRoot": str(self._job_graph_root(job)),
            "jobId": job.job_id,
            "jobKind": job.kind,
            "strictVisibleLanguage": "auto",
        }
        locale = job.args.get("locale")
        if locale:
            payload["locale"] = str(locale)
        expected_commit = self._expected_git_commit_hash(job)
        if expected_commit:
            payload["expectedGitCommitHash"] = expected_commit
        return payload

    @staticmethod
    def _runtime_output_action(job: JobSnapshot) -> str:
        if job.kind == "understand-domain":
            return "compile_domain_ir"
        return "validate_outputs"

    def _append_runtime_observations(
        self,
        job: JobSnapshot,
        action: str,
        result: dict[str, Any],
    ) -> None:
        observations = result.get("observations")
        if not isinstance(observations, list):
            return
        for observation in observations:
            if not isinstance(observation, dict):
                continue
            title = str(observation.get("title") or action)
            message = str(observation.get("message") or title)
            stage = observation.get("stage")
            status = observation.get("status")
            details = observation.get("details")
            self.jobs.append_observation(
                job.job_id,
                kind=str(observation.get("kind") or "system"),
                level=str(observation.get("level") or "info"),
                title=title,
                message=message,
                stage=str(stage) if stage is not None else None,
                status=str(status) if status is not None else None,
                details=details if isinstance(details, dict) else None,
                observation_id=self._runtime_observation_id(action, observation),
            )

    @staticmethod
    def _runtime_observation_id(action: str, observation: dict[str, Any]) -> str:
        material = json.dumps(
            {
                "action": action,
                "kind": observation.get("kind"),
                "title": observation.get("title"),
                "message": observation.get("message"),
                "stage": observation.get("stage"),
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        digest = hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]
        return f"runtime-{action}-{digest}"

    def _expected_git_commit_hash(self, job: JobSnapshot) -> str | None:
        configured = job.args.get("expected_git_commit_hash")
        if configured:
            return str(configured)
        return self._git_head(job.project_root)

    def _validate_required_outputs(self, job: JobSnapshot) -> None:
        required = REQUIRED_GRAPH_OUTPUTS_BY_JOB.get(job.kind, ())
        if not required:
            return
        graph_root = self._job_graph_root(job)
        missing = [
            file_name
            for file_name in required
            if not (graph_root / file_name).is_file()
        ]
        if missing:
            raise RuntimeError(
                "Understand Anything job did not produce required graph file(s): "
                + ", ".join(missing)
                + f". Expected under: {graph_root}"
            )
        payloads: dict[str, dict[str, Any]] = {}
        for file_name in required:
            payloads[file_name] = self._read_graph_json(graph_root, file_name)
        if job.kind in {"understand", "understand-knowledge"}:
            self._validate_understand_fingerprints(payloads)

    @staticmethod
    def _read_graph_json(graph_root: Path, file_name: str) -> dict[str, Any]:
        relative = Path(file_name)
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError(f"Invalid graph file path: {file_name}")
        path = graph_root.joinpath(*relative.parts)
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise RuntimeError(f"Graph file must contain a JSON object: {path}")
        return data

    def _update_project_status_for_job(
        self,
        job: JobSnapshot,
        status: ProjectStatus,
        **updates: Any,
    ) -> None:
        project_id = str(job.args.get("project_id") or "").strip()
        if not project_id:
            return
        try:
            self.registry.update_status(project_id, status, **updates)
        except ProjectRegistryError as exc:
            logger.warning("Unable to update UA project status: %s", exc)

    def _job_graph_counts(self, job: JobSnapshot) -> tuple[int, int]:
        graph_root = self._job_graph_root(job)
        for file_name in ("knowledge-graph.json", "domain-graph.json"):
            path = graph_root / file_name
            if not path.is_file():
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            nodes = payload.get("nodes")
            edges = payload.get("edges")
            return (
                len(nodes) if isinstance(nodes, list) else 0,
                len(edges) if isinstance(edges, list) else 0,
            )
        return (0, 0)

    @staticmethod
    def _validate_understand_fingerprints(
        payloads: dict[str, dict[str, Any]],
    ) -> None:
        meta = payloads.get("meta.json") or {}
        fingerprints = payloads.get("fingerprints.json") or {}
        if fingerprints.get("version") != "1.0.0":
            raise RuntimeError("Invalid fingerprints.json: version must be 1.0.0.")
        fingerprint_commit = fingerprints.get("gitCommitHash")
        if not isinstance(fingerprint_commit, str):
            raise RuntimeError(
                "Invalid fingerprints.json: gitCommitHash must be a string."
            )
        files = fingerprints.get("files")
        if not isinstance(files, dict) or not files:
            raise RuntimeError("Invalid fingerprints.json: files must be non-empty.")
        meta_commit = meta.get("gitCommitHash")
        if fingerprint_commit != meta_commit:
            raise RuntimeError(
                "Invalid fingerprints.json: gitCommitHash must match meta.json."
            )

    @staticmethod
    def _job_graph_root(job: JobSnapshot) -> Path:
        value = job.args.get("graph_root")
        return Path(str(value)) if value else job.project_root / ".understand-anything"

    @staticmethod
    def _coerce_positive_int(value: Any, default: int) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return default
        return max(1, number)

    def _select_status_job(
        self,
        project_ref: str | None,
    ) -> tuple[JobSnapshot | None, list[JobSnapshot]]:
        normalized = (project_ref or "").strip()
        if normalized:
            matches = [
                job
                for job in self.jobs.list()
                if self._job_matches_status_ref(job, normalized)
            ]
            if not matches:
                record = self._registry_record_for_status_ref(normalized)
                if record is not None:
                    matches = [
                        job
                        for job in self.jobs.list()
                        if self._job_project_key(job) == record.project_id
                        or self._paths_equal(job.project_root, record.path)
                    ]
            if not matches:
                return None, []
            grouped = self._latest_job_by_project(matches)
            if len(grouped) > 1:
                return None, grouped
            return self._pick_status_job(matches), []
        jobs = self.jobs.list()
        return self._pick_status_job(jobs), []

    def _pick_status_job(self, jobs: list[JobSnapshot]) -> JobSnapshot | None:
        if not jobs:
            return None
        return next(
            (job for job in jobs if job.status in ACTIVE_JOB_STATUSES),
            jobs[0],
        )

    def _latest_job_by_project(self, jobs: list[JobSnapshot]) -> list[JobSnapshot]:
        grouped: dict[str, JobSnapshot] = {}
        for job in jobs:
            key = self._job_project_key(job)
            current = grouped.get(key)
            if current is None or job.created_at > current.created_at:
                grouped[key] = job
        return sorted(grouped.values(), key=lambda job: job.created_at, reverse=True)

    def _job_matches_status_ref(self, job: JobSnapshot, project_ref: str) -> bool:
        return any(
            self._status_values_equal(candidate, project_ref)
            for candidate in self._job_status_candidates(job)
        )

    def _job_status_candidates(self, job: JobSnapshot) -> list[str]:
        candidates = [
            str(job.args.get("status_ref") or ""),
            str(job.args.get("project_display_name") or ""),
            job.project_root.name,
            str(job.project_root),
            str(self._job_graph_root(job)),
        ]
        aliases = job.args.get("status_aliases")
        if isinstance(aliases, list):
            candidates.extend(str(alias) for alias in aliases)
        source = job.args.get("source")
        if isinstance(source, dict):
            owner = str(source.get("owner") or "").strip()
            repo = str(source.get("repo") or "").strip()
            if repo:
                candidates.append(repo)
            if owner and repo:
                candidates.append(f"{owner}/{repo}")
            for key in ("display_name", "repo_url", "target_url", "cache_path"):
                value = str(source.get(key) or "").strip()
                if value:
                    candidates.append(value)
        return [candidate for candidate in candidates if candidate.strip()]

    def _status_values_equal(self, candidate: str, project_ref: str) -> bool:
        left = str(candidate or "").strip()
        right = str(project_ref or "").strip()
        if not left or not right:
            return False
        if left.casefold() == right.casefold():
            return True
        if self._looks_like_filesystem_path(left) or self._looks_like_filesystem_path(
            right
        ):
            return self._paths_equal(left, right)
        return False

    @staticmethod
    def _paths_equal(left: str | Path, right: str | Path) -> bool:
        try:
            return Path(left).expanduser().resolve(strict=False) == Path(
                right
            ).expanduser().resolve(strict=False)
        except (OSError, RuntimeError, ValueError):
            return False

    @staticmethod
    def _looks_like_filesystem_path(value: str) -> bool:
        text = str(value or "").strip()
        if not text or text.startswith(("http://", "https://")):
            return False
        return (
            Path(text).is_absolute()
            or text.startswith((".", "~"))
            or "\\" in text
            or ":" in text
        )

    def _job_project_key(self, job: JobSnapshot) -> str:
        project_id = str(job.args.get("project_id") or "").strip()
        if project_id:
            return project_id
        return str(job.project_root.resolve(strict=False)).casefold()

    def _registry_record_for_status_ref(self, project_ref: str):
        normalized = str(project_ref or "").strip()
        if not normalized:
            return None
        for record in self.registry.list():
            candidates = [
                record.name,
                record.path,
                record.graph_root,
                Path(record.path).name,
                *(record.aliases or []),
            ]
            if any(
                self._status_values_equal(str(candidate), normalized)
                for candidate in candidates
            ):
                return record
        return None

    def _format_progress_step(
        self,
        steps: list[dict[str, Any]],
        locale: str,
    ) -> str:
        if not steps:
            return self._localized(
                locale,
                zh="未知",
                en="unknown",
                ru="неизвестно",
            )
        active_index = next(
            (
                index
                for index, step in enumerate(steps)
                if step.get("status") in {"active", "failed", "cancelled"}
            ),
            len(steps) - 1,
        )
        step = steps[active_index]
        label = self._phase_label(str(step.get("phase") or ""), locale)
        if not label:
            label = str(step.get("label") or "unknown")
        return f"{active_index + 1}/{len(steps)} {label}"

    @staticmethod
    def _format_timestamp(value: float) -> str:
        return datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M:%S")

    @staticmethod
    def _truncate_status_text(value: str, limit: int = 240) -> str:
        text = " ".join(str(value).split())
        if len(text) <= limit:
            return text
        return text[: limit - 3].rstrip() + "..."

    @staticmethod
    def _localized(locale: str, *, zh: str, en: str, ru: str) -> str:
        if locale == "en-US":
            return en
        if locale == "ru-RU":
            return ru
        return zh

    def _job_locale(self, job: JobSnapshot) -> str:
        return self._resolve_output_locale(
            str(job.args.get("locale") or "") or None,
        )

    def _job_display_name(self, job: JobSnapshot) -> str:
        display_name = str(job.args.get("project_display_name") or "").strip()
        if display_name:
            return display_name
        source = job.args.get("source")
        if isinstance(source, dict):
            repo = str(source.get("repo") or "").strip()
            if repo:
                return repo
            display_name = str(source.get("display_name") or "").strip()
            if display_name:
                return display_name
        return job.project_root.name or str(job.project_root)

    def _status_ref_for_job(self, job: JobSnapshot) -> str:
        return (
            str(job.args.get("status_ref") or "").strip()
            or self._job_display_name(job)
            or job.project_root.name
            or str(job.project_root)
        )

    def _command_status_ref(self, job: JobSnapshot) -> str:
        return quote_arg(self._status_ref_for_job(job))

    def _status_command(self, job: JobSnapshot) -> str:
        return f"/understand status {self._command_status_ref(job)}"

    @staticmethod
    def _initial_project_display_name(
        project_root: Path,
        checkout: GitHubRepoCheckout | None,
    ) -> str:
        if checkout is not None:
            return checkout.repo
        return project_root.name or str(project_root)

    @staticmethod
    def _initial_status_ref(
        project_root: Path,
        checkout: GitHubRepoCheckout | None,
    ) -> str:
        if checkout is not None:
            return checkout.repo
        return project_root.name or str(project_root)

    @staticmethod
    def _initial_status_aliases(
        project_root: Path,
        checkout: GitHubRepoCheckout | None,
    ) -> list[str]:
        aliases = {project_root.name, str(project_root)}
        if checkout is not None:
            aliases.update(
                {
                    checkout.repo,
                    checkout.display_name,
                    checkout.repo_url,
                    checkout.target_url,
                    str(checkout.worktree_path),
                    str(checkout.artifact_root),
                }
            )
            aliases.update(checkout.aliases)
        return sorted(
            (alias for alias in aliases if str(alias).strip()),
            key=str.casefold,
        )

    def _job_label(self, job_label: str, locale: str) -> str:
        normalized = str(job_label or "analysis").strip().casefold()
        if normalized == "domain analysis":
            return self._localized(
                locale,
                zh="领域分析",
                en="domain analysis",
                ru="доменный анализ",
            )
        if normalized == "knowledge analysis":
            return self._localized(
                locale,
                zh="知识库分析",
                en="knowledge analysis",
                ru="анализ базы знаний",
            )
        return self._localized(
            locale,
            zh="分析",
            en="analysis",
            ru="анализ",
        )

    def _status_label(self, status: JobStatus, locale: str) -> str:
        labels = {
            JobStatus.QUEUED: self._localized(
                locale,
                zh="排队中",
                en="queued",
                ru="в очереди",
            ),
            JobStatus.RUNNING: self._localized(
                locale,
                zh="运行中",
                en="running",
                ru="выполняется",
            ),
            JobStatus.WAITING_CONFIRMATION: self._localized(
                locale,
                zh="等待确认",
                en="waiting for confirmation",
                ru="ожидает подтверждения",
            ),
            JobStatus.FINISHED: self._localized(
                locale,
                zh="已完成",
                en="finished",
                ru="завершено",
            ),
            JobStatus.FAILED: self._localized(
                locale,
                zh="失败",
                en="failed",
                ru="ошибка",
            ),
            JobStatus.CANCELLED: self._localized(
                locale,
                zh="已取消",
                en="cancelled",
                ru="отменено",
            ),
        }
        return labels.get(status, status.value)

    def _phase_label(self, phase: str, locale: str) -> str:
        normalized = str(phase or "").strip()
        labels = {
            "queued": self._localized(locale, zh="排队", en="queued", ru="очередь"),
            "source": self._localized(
                locale,
                zh="获取源码",
                en="preparing source",
                ru="подготовка исходного кода",
            ),
            "confirmation": self._localized(
                locale,
                zh="确认扫描范围",
                en="confirm scan scope",
                ru="подтверждение области сканирования",
            ),
            "runtime": self._localized(
                locale,
                zh="准备运行环境",
                en="preparing runtime",
                ru="подготовка среды выполнения",
            ),
            "agent": self._localized(
                locale,
                zh="生成图谱",
                en="generating graph",
                ru="построение графа",
            ),
            "validate": self._localized(
                locale,
                zh="验证产物",
                en="validating outputs",
                ru="проверка результатов",
            ),
            "complete": self._localized(
                locale,
                zh="完成",
                en="complete",
                ru="завершено",
            ),
            "failed": self._localized(locale, zh="失败", en="failed", ru="ошибка"),
            "cancelled": self._localized(
                locale,
                zh="已取消",
                en="cancelled",
                ru="отменено",
            ),
        }
        return labels.get(normalized, normalized.replace("_", " ") or "unknown")

    def _source_stage_label(self, job: JobSnapshot, locale: str) -> str:
        source = job.args.get("source")
        if isinstance(source, dict) and source.get("type") == "github":
            return self._localized(
                locale,
                zh="下载 GitHub 仓库",
                en="download GitHub repository",
                ru="загрузка репозитория GitHub",
            )
        return self._localized(
            locale,
            zh="读取本地项目",
            en="read local project",
            ru="чтение локального проекта",
        )

    def _format_status_not_found(self, project_ref: str, locale: str) -> str:
        available = self._available_status_refs()
        suffix = ""
        if available:
            suffix = self._localized(
                locale,
                zh=f"\n可用项目：{available}",
                en=f"\nAvailable projects: {available}",
                ru=f"\nДоступные проекты: {available}",
            )
        return (
            self._localized(
                locale,
                zh=f"没有找到分析任务：{project_ref}",
                en=f"Understand Anything project not found: {project_ref}",
                ru=f"Проект Understand Anything не найден: {project_ref}",
            )
            + suffix
        )

    def _format_ambiguous_status_ref(
        self,
        project_ref: str,
        jobs: list[JobSnapshot],
        locale: str,
    ) -> str:
        options = ", ".join(self._disambiguation_ref_for_job(job) for job in jobs)
        return self._localized(
            locale,
            zh=f"匹配到多个项目：{project_ref}\n请改用更明确的项目名：{options}",
            en=(
                f"Multiple projects match: {project_ref}\n"
                f"Use a more specific project name: {options}"
            ),
            ru=(
                f"Найдено несколько проектов: {project_ref}\n"
                f"Используйте более точное имя проекта: {options}"
            ),
        )

    def _available_status_refs(self) -> str:
        refs: list[str] = []
        seen: set[str] = set()
        for job in self.jobs.list():
            ref = self._disambiguation_ref_for_job(job)
            key = ref.casefold()
            if key in seen:
                continue
            seen.add(key)
            refs.append(ref)
        return ", ".join(refs[:8])

    def _disambiguation_ref_for_job(self, job: JobSnapshot) -> str:
        aliases = job.args.get("status_aliases")
        if isinstance(aliases, list):
            for alias in aliases:
                text = str(alias or "").strip()
                if (
                    "/" in text
                    and not text.startswith(("http://", "https://"))
                    and not self._looks_like_filesystem_path(text)
                ):
                    return text
        return self._status_ref_for_job(job)

    def _project_root_from_args(self, raw_args: str) -> Path:
        token = self._first_path_token(raw_args)
        return self.security.resolve_project_path(token)

    def _github_checkout_from_request(
        self,
        *,
        repo_url: str | None,
        ref: str | None,
        parsed_path: str | None,
        github_proxy: str | None,
    ) -> GitHubRepoCheckout | None:
        candidate = (repo_url or "").strip()
        if candidate:
            return self.github.resolve(candidate, ref, github_proxy)
        if not parsed_path:
            return None
        if GitHubRepoManager.looks_like_github_url(parsed_path):
            return self.github.resolve(parsed_path, ref, github_proxy)
        if GitHubRepoManager.is_http_url(parsed_path):
            raise GitHubRepoError(
                "Only public https://github.com repository URLs are supported."
            )
        return None

    def _github_checkout_from_registry(
        self,
        *,
        project_id: str | None,
        project_name: str | None,
        project_ref: str | None,
        github_proxy: str | None = None,
    ) -> GitHubRepoCheckout | None:
        if not (project_id or project_name or project_ref):
            return None
        try:
            record = self.registry.resolve_record(
                project_id=project_id,
                project_name=project_name,
                project_ref=project_ref,
            )
        except ProjectRegistryError:
            return None
        source = record.source if isinstance(record.source, dict) else {}
        if source.get("type") != "github":
            return None
        selected_proxy = github_proxy or self._source_github_proxy(source)
        owner = str(source.get("owner") or "")
        repo = str(source.get("repo") or "")
        if owner and repo:
            return self.github.checkout_from_metadata(
                owner=owner,
                repo=repo,
                ref=str(source.get("ref")) if source.get("ref") else None,
                subpath=str(source.get("subpath")) if source.get("subpath") else None,
                github_proxy=selected_proxy,
            )
        target_url = str(source.get("target_url") or source.get("repo_url") or "")
        if not target_url:
            return None
        return self.github.resolve(target_url, github_proxy=selected_proxy)

    @staticmethod
    def _github_source_payload(checkout: GitHubRepoCheckout | None) -> dict[str, Any]:
        if not checkout:
            return {"type": "local"}
        return {
            "type": "github",
            "owner": checkout.owner,
            "repo": checkout.repo,
            "repo_url": checkout.repo_url,
            "target_url": checkout.target_url,
            "clone_url": checkout.clone_url,
            "github_proxy": checkout.github_proxy,
            "ref": checkout.ref,
            "subpath": checkout.subpath,
            "cache_path": str(checkout.worktree_path),
            "artifact_root": str(checkout.artifact_root),
            "graph_root": str(checkout.graph_root),
            "source_key": checkout.source_key,
            "display_name": checkout.display_name,
        }

    async def _prepare_job_source(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
    ) -> None:
        source = job.args.get("source")
        if not isinstance(source, dict) or source.get("type") != "github":
            return
        has_target_url = bool(source.get("target_url"))
        repo_url = str(source.get("target_url") or source.get("repo_url") or "")
        ref = None if has_target_url else source.get("ref")
        await self._set_job_progress(
            job,
            event,
            job.job_id,
            "source",
            "Resolving GitHub repository reference.",
            16,
        )
        self.jobs.append_log(
            job.job_id,
            "Resolving GitHub repository reference.",
        )

        async def progress(message: str) -> None:
            await self._set_job_progress(job, event, job.job_id, "source", message, 18)
            self.jobs.append_log(job.job_id, message)

        checkout = await self.github.resolve_remote(
            repo_url,
            str(ref) if ref else None,
            self._source_github_proxy(source),
            progress=progress,
        )
        self.jobs.append_log(
            job.job_id,
            f"Preparing GitHub repository {checkout.display_name}"
            + (f" at {checkout.ref}" if checkout.ref else "")
            + (f" subpath {checkout.subpath}" if checkout.subpath else ""),
        )

        result = await self.github.prepare_with_checkout(checkout, progress=progress)
        checkout = result.checkout
        analysis_root = result.path
        job.project_root = analysis_root
        job.args["project_path"] = str(analysis_root)
        job.args["graph_root"] = str(checkout.graph_root)
        job.args["project_id"] = ProjectRegistry.project_id_for(checkout.artifact_root)
        job.args["project_display_name"] = self._initial_project_display_name(
            analysis_root,
            checkout,
        )
        job.args["status_ref"] = self._initial_status_ref(analysis_root, checkout)
        job.args["status_aliases"] = self._initial_status_aliases(
            analysis_root,
            checkout,
        )
        job.args["raw_args"] = format_job_args(
            analysis_root,
            job.args.get("flags") if isinstance(job.args.get("flags"), list) else [],
        )
        job.args["source"] = self._github_source_payload(checkout)
        self.jobs.append_log(
            job.job_id, f"GitHub repository ready: {checkout.worktree_path}"
        )
        if checkout.subpath:
            self.jobs.append_log(
                job.job_id, f"GitHub analysis subpath ready: {analysis_root}"
            )
        self.registry.register(
            analysis_root,
            job_id=job.job_id,
            auto_update=(
                job.args.get("auto_update")
                if isinstance(job.args.get("auto_update"), bool)
                else None
            ),
            aliases=self._job_source_aliases(job),
            graph_root=checkout.graph_root,
            source=self._github_source_payload(checkout),
        )

    def _cleanup_github_cache_after_job(self, job: JobSnapshot) -> None:
        if not bool(self.config.get("cleanup_github_cache_after_analysis", False)):
            return
        source = job.args.get("source")
        if not isinstance(source, dict) or source.get("type") != "github":
            return
        if self._github_cache_in_use_by_other_job(job, source):
            self.jobs.append_log(
                job.job_id,
                "GitHub clone cache cleanup skipped; another job is using it.",
            )
            return
        try:
            target_url = str(source.get("target_url") or source.get("repo_url") or "")
            ref = str(source.get("ref")) if source.get("ref") else None
            checkout = self.github.resolve(
                target_url,
                None if source.get("target_url") else ref,
                self._source_github_proxy(source),
            )
            removed = self.github.remove_cache(checkout)
        except Exception as exc:
            logger.warning("GitHub cache cleanup failed: %s", exc)
            try:
                self.jobs.append_log(job.job_id, f"GitHub cache cleanup failed: {exc}")
            except Exception:
                pass
            return
        if removed:
            self.jobs.append_log(
                job.job_id, "GitHub clone cache cleaned; artifacts retained."
            )

    def _github_cache_in_use_by_other_job(
        self,
        job: JobSnapshot,
        source: dict[str, Any],
    ) -> bool:
        cache_path = source.get("cache_path")
        if not cache_path:
            return False
        current = Path(str(cache_path)).resolve(strict=False)
        for other in self.jobs.list():
            if other.job_id == job.job_id:
                continue
            if other.status.value not in {"queued", "running"}:
                continue
            other_source = other.args.get("source")
            if not isinstance(other_source, dict):
                continue
            other_cache_path = other_source.get("cache_path")
            if not other_cache_path:
                continue
            if Path(str(other_cache_path)).resolve(strict=False) == current:
                return True
        return False

    @staticmethod
    def _source_github_proxy(source: dict[str, Any]) -> str | None:
        proxy = source.get("github_proxy")
        return str(proxy).strip() if proxy else None

    @staticmethod
    def _job_source_aliases(job: JobSnapshot) -> list[str] | None:
        source = job.args.get("source")
        if not isinstance(source, dict) or source.get("type") != "github":
            return None
        aliases = [
            str(value)
            for value in (
                source.get("repo"),
                source.get("display_name"),
                source.get("repo_url"),
                source.get("target_url"),
                source.get("cache_path"),
            )
            if value
        ]
        ref = source.get("ref")
        display_name = source.get("display_name")
        if ref and display_name:
            aliases.append(f"{display_name}@{ref}")
            subpath = source.get("subpath")
            if subpath:
                aliases.append(f"{display_name}@{ref}:{subpath}")
        return aliases or None

    def _resolve_job_project_root(
        self,
        *,
        raw_args: str,
        parsed_path: str | None,
        project_path: str | Path | None,
        project_id: str | None,
        project_name: str | None,
        project_ref: str | None,
    ) -> Path:
        if project_path:
            return self.security.resolve_project_path(project_path)
        if project_id or project_name or project_ref:
            return self.resolve_project_root(
                project_id=project_id,
                project_name=project_name,
                project_ref=project_ref,
            )
        if parsed_path:
            return self.security.resolve_project_path(parsed_path)
        return self.security.resolve_project_path(self._first_path_token(raw_args))

    @staticmethod
    def _first_path_token(raw_args: str) -> str | None:
        for token in UnderstandAnythingRunner._split_args(raw_args):
            if not token.startswith("--"):
                return token
        return None

    @staticmethod
    def _split_args(raw_args: str) -> list[str]:
        return split_args(raw_args)

    @staticmethod
    def _git_changed_files(project_root: Path) -> list[str]:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "diff", "--name-only"],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return []
        return [line.strip() for line in proc.stdout.splitlines() if line.strip()]

    def _track_project_from_flags(
        self,
        project_root: Path,
        flags: Sequence[str],
    ) -> bool | None:
        setting = self._auto_update_setting_from_flags(flags)
        if setting is True:
            self._auto_update_projects.add(project_root)
        elif setting is False:
            self._auto_update_projects.discard(project_root)
        return setting

    @staticmethod
    def _auto_update_setting_from_flags(flags: Sequence[str]) -> bool | None:
        tokens = set(flags)
        if "--auto-update" in tokens:
            return True
        if "--no-auto-update" in tokens:
            return False
        return None

    @staticmethod
    def _auto_update_poll_seconds(value: Any) -> int:
        try:
            minutes = int(value or 0)
        except (TypeError, ValueError):
            return 0
        return max(0, minutes) * 60

    def _discover_auto_update_projects(self) -> None:
        candidates = {
            Path(record.path) for record in self.registry.list() if record.auto_update
        }
        for root in list(candidates):
            if root.is_dir():
                candidates.update(
                    path.parent.parent
                    for path in root.glob("*/.understand-anything/config.json")
                )
        for project_root in candidates:
            if self._project_auto_update_enabled(project_root):
                self._auto_update_projects.add(project_root)

    async def _run_auto_update_pass(self) -> None:
        self._discover_auto_update_projects()
        for project_root in sorted(self._auto_update_projects):
            if not self._project_auto_update_enabled(project_root):
                self._auto_update_projects.discard(project_root)
                continue
            if self._has_running_project_job(project_root):
                continue
            if not self._project_is_stale(project_root):
                continue
            raw_args = format_job_args(project_root)
            job = self.jobs.create(
                "understand",
                project_root,
                {"raw_args": raw_args, "auto_update": True},
            )
            self.registry.register(
                project_root,
                job_id=job.job_id,
                auto_update=True,
            )
            self.jobs.append_log(job.job_id, "Auto-update detected a new git commit.")
            self._tasks[job.job_id] = asyncio.create_task(
                self._run_skill_job(job, None),
            )

    def _has_running_project_job(self, project_root: Path) -> bool:
        return any(
            job.project_root == project_root
            and job.status.value in {"queued", "running"}
            for job in self.jobs.list()
        )

    @staticmethod
    def _project_auto_update_enabled(project_root: Path) -> bool:
        config_path = project_root / ".understand-anything" / "config.json"
        if not config_path.is_file():
            return False
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return isinstance(config, dict) and config.get("autoUpdate") is True

    @staticmethod
    def _project_is_stale(project_root: Path) -> bool:
        meta_path = project_root / ".understand-anything" / "meta.json"
        if not meta_path.is_file():
            return False
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        previous_commit = meta.get("gitCommitHash") if isinstance(meta, dict) else None
        current_commit = UnderstandAnythingRunner._git_head(project_root)
        return bool(
            previous_commit and current_commit and previous_commit != current_commit
        )

    @staticmethod
    def _git_head(project_root: Path) -> str | None:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return None
        return proc.stdout.strip() or None

    @staticmethod
    def _synthetic_event(job: JobSnapshot) -> AstrMessageEvent:
        message = AstrBotMessage()
        text = (
            f"/{SKILL_COMMANDS.get(job.kind, job.kind)} {job.args.get('raw_args', '')}"
        )
        message.type = MessageType.FRIEND_MESSAGE
        message.self_id = PLUGIN_NAME
        message.session_id = f"dashboard:{job.job_id}"
        message.message_id = job.job_id
        message.sender = MessageMember(
            user_id="dashboard", nickname="AstrBot Dashboard"
        )
        message.message = [Plain(text=text)]
        message.message_str = text
        message.raw_message = {"source": "plugin-page", "job_id": job.job_id}
        event = AstrMessageEvent(
            text,
            message,
            PlatformMetadata(
                name="plugin-page",
                description="AstrBot plugin page background job",
                id=PLUGIN_NAME,
            ),
            message.session_id,
        )
        event.role = "admin"
        event.is_wake = True
        event.is_at_or_wake_command = True
        return event

    async def _auto_update_loop(self, interval: int) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await self._run_auto_update_pass()
            except Exception as exc:
                logger.warning("Understand Anything auto-update poll failed: %s", exc)
