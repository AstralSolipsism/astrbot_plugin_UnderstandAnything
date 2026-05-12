from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.core.message.components import Plain
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.star import Context

from .computer_use import ensure_computer_use_enabled
from .constants import (
    AGENT_PROMPTS_ROOT,
    PLUGIN_NAME,
    PLUGIN_SKILLS_ROOT,
    SKILL_COMMANDS,
)
from .github_repo import GitHubRepoCheckout, GitHubRepoError, GitHubRepoManager
from .job_request import format_job_args, parse_job_args, split_args
from .job_store import JobSnapshot, JobStore
from .llm_dispatcher import LLMDispatcher, read_prompt_file
from .path_security import PathSecurity
from .project_registry import ProjectRegistry, ProjectRegistryError
from .project_store import ProjectStore
from .runtime import UnderstandAnythingRuntime
from .subagent_dispatcher import UnderstandAnythingSubAgentDispatcher
from .subagent_registry import UnderstandAnythingSubAgentRegistry

REQUIRED_GRAPH_OUTPUTS_BY_JOB = {
    "understand": ("knowledge-graph.json",),
    "understand-domain": ("domain-graph.json",),
    "understand-knowledge": ("knowledge-graph.json",),
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
        self.github = GitHubRepoManager()
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
        self._auto_update_task: asyncio.Task | None = None
        self._auto_update_projects: set[Path] = set()
        self.registry = ProjectRegistry(Path(registry_path) if registry_path else None)

    async def initialize(self) -> None:
        try:
            interval = int(self.config.get("auto_update_poll_interval") or 0)
        except (TypeError, ValueError):
            interval = 0
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
        await self.github.prepare(checkout)

    async def start_skill_job(
        self,
        *,
        skill_name: str,
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
    ) -> JobSnapshot:
        parsed = parse_job_args(raw_args)
        selected_flags = list(flags) if flags is not None else parsed.flags
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
            github_proxy=github_proxy,
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
                github_proxy=github_proxy,
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
        auto_update = self._auto_update_setting_from_flags(selected_flags)
        job = self.jobs.create(
            skill_name,
            project_root,
            {
                "raw_args": display_args,
                "project_path": str(project_root),
                "project_id": ProjectRegistry.project_id_for(
                    graph_root.parent if github_checkout else project_root,
                ),
                "graph_root": str(graph_root),
                "flags": selected_flags,
                "auto_update": auto_update,
                "source": source_payload,
            },
        )
        if not github_checkout:
            self._track_project_from_flags(project_root, selected_flags)
        aliases = github_checkout.aliases if github_checkout else None
        if not github_checkout:
            self.registry.register(
                project_root,
                job_id=job.job_id,
                auto_update=auto_update,
                aliases=aliases,
            )
        if start_task:
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
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action(
            "chat_prompt",
            {"graph": graph, "query": query},
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Answer using the provided Understand Anything graph context.",
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
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action(
            "explain_prompt",
            {"graph": graph, "path": target},
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Explain the requested component from the graph context.",
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
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        files = changed_files or self._git_changed_files(store.project_root)
        payload = await self.runtime.run_action(
            "diff_markdown",
            {"graph": graph, "changedFiles": files},
        )
        store.write_json(
            "diff-overlay.json",
            {
                "changedNodeIds": payload.get("changedNodeIds", []),
                "affectedNodeIds": payload.get("affectedNodeIds", []),
                "unmappedFiles": payload.get("unmappedFiles", []),
            },
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Analyze diff impact and risks from the graph context.",
        )

    async def onboard(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action("onboard_markdown", {"graph": graph})
        return str(payload["markdown"])

    async def _run_skill_job(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
    ) -> None:
        agent_event = event or self._synthetic_event(job)
        try:
            async with self._job_semaphore:
                self.jobs.mark_running(job.job_id)
                self.jobs.append_log(
                    job.job_id,
                    f"Starting {job.kind} job.",
                )
                await self._prepare_job_source(job)
                self.jobs.append_log(
                    job.job_id, f"Target project root: {job.project_root}"
                )
                self._ensure_graph_root_defaults(job)
                ensure_computer_use_enabled(
                    self.context,
                    umo=getattr(event, "unified_msg_origin", None) if event else None,
                )
                await self.runtime.ensure_ready()
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
                )
                if event is not None:
                    await event.send(
                        MessageChain().message(
                            f"Understand Anything job finished: {job.kind}\n{result}",
                        ),
                    )
        except asyncio.CancelledError:
            self.jobs.mark_failed(job.job_id, "Job cancelled.")
            raise
        except Exception as exc:
            logger.error("Understand Anything job failed: %s", exc)
            self.jobs.mark_failed(job.job_id, str(exc))
            if event is not None:
                await event.send(
                    MessageChain().message(
                        f"Understand Anything job failed: {job.kind}\n{exc}",
                    ),
                )
        finally:
            self._cleanup_github_cache_after_job(job)

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
            "- Preserve Understand Anything JSON schema and Dashboard compatibility.\n"
        )

    def _ensure_graph_root_defaults(self, job: JobSnapshot) -> None:
        graph_root = self._job_graph_root(job)
        graph_root.mkdir(parents=True, exist_ok=True)
        (graph_root / ".understandignore").touch(exist_ok=True)

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
        store = ProjectStore(job.project_root, graph_root=graph_root)
        for file_name in required:
            store.read_json(file_name)

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

    async def _prepare_job_source(self, job: JobSnapshot) -> None:
        source = job.args.get("source")
        if not isinstance(source, dict) or source.get("type") != "github":
            return
        has_target_url = bool(source.get("target_url"))
        repo_url = str(source.get("target_url") or source.get("repo_url") or "")
        ref = None if has_target_url else source.get("ref")
        checkout = await self.github.resolve_remote(
            repo_url,
            str(ref) if ref else None,
            self._source_github_proxy(source),
        )
        self.jobs.append_log(
            job.job_id,
            f"Preparing GitHub repository {checkout.display_name}"
            + (f" at {checkout.ref}" if checkout.ref else "")
            + (f" subpath {checkout.subpath}" if checkout.subpath else ""),
        )
        analysis_root = await self.github.prepare(checkout)
        job.project_root = analysis_root
        job.args["project_path"] = str(analysis_root)
        job.args["graph_root"] = str(checkout.graph_root)
        job.args["project_id"] = ProjectRegistry.project_id_for(checkout.artifact_root)
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
            aliases=checkout.aliases,
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
                source.get("display_name"),
                source.get("repo_url"),
                source.get("target_url"),
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
