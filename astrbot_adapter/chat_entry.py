from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .computer_use import computer_use_status
from .constants import PLUGIN_NAME, UNDERSTAND_ANYTHING_ROOT
from .github_repo import GitHubRepoManager
from .ignore_review import append_ignore_patterns
from .job_store import JobSnapshot, JobStatus
from .project_registry import ProjectStatus
from .runtime_tools import detect_runtime_tools, runtime_readiness

UnderstandAnythingSubAgentRegistry: Any = None

ACTIVE_JOB_STATUSES = {
    JobStatus.QUEUED,
    JobStatus.RUNNING,
    JobStatus.WAITING_CONFIRMATION,
}
CONTENT_INTENTS = {"ask", "explain", "diff", "onboard", "domain"}
START_INTENTS = {"start_analysis", "rerun_analysis"}
TOOL_ACTION_INTENTS = {
    "status",
    "start_analysis",
    "rerun_analysis",
    "stop_job",
    "open_dashboard",
    "diagnose",
    "repair_runtime",
}
LEGACY_SUBCOMMANDS = {
    "analyze",
    "status",
    "chat",
    "diff",
    "domain",
    "explain",
    "knowledge",
    "onboard",
    "dashboard",
}
PUBLIC_STATES = (
    "no_project",
    "ambiguous_project",
    "project_selected_no_graph",
    "source_preparing",
    "analysis_running",
    "analysis_failed",
    "graph_ready",
    "blocked_runtime",
    "blocked_subagents",
    "blocked_computer_use",
)


@dataclass(slots=True)
class ChatIntent:
    intent: str
    query: str = ""
    source: str = ""
    target: str = ""
    project_hint: str = ""
    mode: str = ""
    options: dict[str, Any] = field(default_factory=dict)
    requires_lightweight_llm: bool = False


@dataclass(slots=True)
class ChatState:
    name: str
    project: dict[str, Any] | None = None
    running_job: dict[str, Any] | None = None
    blockers: list[str] = field(default_factory=list)
    available_actions: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ChatValidation:
    allowed: bool
    message: str = ""


class ChatCommandParser:
    def parse(self, text: str) -> ChatIntent:
        raw = _strip_understand_prefix(text)
        normalized = _normalize_text(raw)
        legacy = _legacy_subcommand(raw)
        if legacy:
            return ChatIntent(intent="legacy_removed", target=legacy)
        if not normalized:
            return ChatIntent(intent="status")
        if normalized in {"状态", "进度", "看状态", "查看状态", "现在状态"}:
            return ChatIntent(intent="status")
        if normalized in {"停止", "取消", "停止分析", "取消分析"}:
            return ChatIntent(intent="stop_job")
        if normalized in {"打开面板", "打开 dashboard", "打开 Dashboard", "面板"}:
            return ChatIntent(intent="open_dashboard")
        if normalized in {"诊断", "检查环境", "环境状态"}:
            return ChatIntent(intent="diagnose")
        if normalized in {"修复", "修复运行环境", "修复插件运行依赖"}:
            return ChatIntent(intent="repair_runtime")

        switch_match = re.match(r"^(?:切换到|切换项目到|使用项目)\s+(.+)$", raw)
        if switch_match:
            return ChatIntent(
                intent="select_project",
                project_hint=switch_match.group(1).strip(),
            )

        rerun_match = re.match(r"^重新分析(?:[，,\s]*(.*))?$", raw)
        if rerun_match:
            rerun_payload = rerun_match.group(1) or ""
            return ChatIntent(
                intent="rerun_analysis",
                project_hint=_text_without_options(rerun_payload),
                options=_options_from_text(rerun_payload),
            )

        analysis_payload = _source_after_prefix(raw, ("开始分析", "分析"))
        analysis_source = _text_without_options(analysis_payload)
        if analysis_source and _looks_like_analysis_source(analysis_source):
            return ChatIntent(
                intent="start_analysis",
                source=analysis_source,
                options=_options_from_text(analysis_payload),
                requires_lightweight_llm=False,
            )

        explain_target = _source_after_prefix(raw, ("解释", "说明"))
        if explain_target:
            return ChatIntent(
                intent="explain",
                target=explain_target,
                query=raw,
                mode="explain",
            )
        if any(
            keyword in normalized
            for keyword in ("当前改动", "现在改动", "diff", "变更")
        ):
            return ChatIntent(intent="diff", query=raw, mode="diff")
        if any(
            keyword in normalized
            for keyword in ("项目导览", "导览", "onboarding", "新手指南")
        ):
            return ChatIntent(intent="onboard", query=raw, mode="onboard")
        if any(keyword in normalized for keyword in ("领域", "domain", "业务图谱")):
            return ChatIntent(intent="domain", query=raw, mode="domain")
        if raw.startswith(("问", "请问")):
            return ChatIntent(intent="ask", query=raw, mode="ask")

        return ChatIntent(
            intent="unknown",
            query=raw,
            requires_lightweight_llm=True,
        )


class LightweightIntentParser:
    def __init__(self, runner: Any) -> None:
        self.runner = runner

    async def parse(
        self,
        text: str,
        *,
        state: ChatState,
        event: Any = None,
    ) -> ChatIntent:
        dispatcher = getattr(self.runner, "dispatcher", None)
        generate = getattr(dispatcher, "generate", None)
        if not callable(generate):
            return self._fallback(text, state)
        payload = {
            "user_text": str(text or ""),
            "current_state": state.name,
            "available_intents": [
                "status",
                "start_analysis",
                "rerun_analysis",
                "stop_job",
                "open_dashboard",
                "diagnose",
                "repair_runtime",
                "ask",
                "explain",
                "diff",
                "onboard",
                "domain",
            ],
            "project_candidates": _project_candidates(self.runner),
            "recent_targets": [],
        }
        prompt = (
            "Convert the user text into one JSON object. Do not answer the user. "
            "Return only JSON with keys: intent, confidence, project_hint, target, "
            "query, mode, needs_clarification.\n"
            + json.dumps(payload, ensure_ascii=False)
        )
        response = await generate(prompt=prompt, event=event, system_prompt="")
        try:
            data = json.loads(str(response).strip())
        except json.JSONDecodeError:
            return self._fallback(text, state)
        intent = str(data.get("intent") or "unknown").strip()
        if intent not in {
            "status",
            "start_analysis",
            "rerun_analysis",
            "stop_job",
            "open_dashboard",
            "diagnose",
            "repair_runtime",
            "ask",
            "explain",
            "diff",
            "onboard",
            "domain",
        }:
            return self._fallback(text, state)
        return ChatIntent(
            intent=intent,
            query=str(data.get("query") or text).strip(),
            target=str(data.get("target") or "").strip(),
            project_hint=str(data.get("project_hint") or "").strip(),
            mode=str(data.get("mode") or intent).strip(),
            requires_lightweight_llm=True,
        )

    @staticmethod
    def _fallback(text: str, state: ChatState) -> ChatIntent:
        if state.name == "graph_ready":
            return ChatIntent(intent="ask", query=str(text or "").strip(), mode="ask")
        return ChatIntent(intent="unknown", query=str(text or "").strip())


class ChatStateResolver:
    def __init__(self, runner: Any) -> None:
        self.runner = runner

    def resolve(
        self,
        project_hint: str = "",
        *,
        intent: ChatIntent | None = None,
        event: Any = None,
    ) -> ChatState:
        active = _latest_active_job(self.runner)
        if active is not None:
            phase = str(active.progress.phase or "")
            return ChatState(
                name="source_preparing" if phase == "source" else "analysis_running",
                running_job=_job_payload(active),
                available_actions=["status", "stop_job", "open_dashboard"],
            )
        if intent is not None and intent.intent in START_INTENTS:
            blocker = _start_blocker_state(self.runner, intent, event)
            if blocker is not None:
                return blocker
        projects = _project_records(self.runner)
        selected = _select_project(projects, project_hint)
        if selected == "ambiguous":
            return ChatState(
                name="ambiguous_project",
                available_actions=[
                    "select_project",
                    "start_analysis",
                    "open_dashboard",
                ],
            )
        if selected is None:
            failed = _latest_failed_job(self.runner)
            if failed is not None:
                return ChatState(
                    name="analysis_failed",
                    running_job=_job_payload(failed),
                    available_actions=["status", "rerun_analysis", "open_dashboard"],
                )
            return ChatState(
                name="no_project",
                available_actions=["start_analysis", "open_dashboard", "diagnose"],
            )
        project = selected.to_dict() if hasattr(selected, "to_dict") else dict(selected)
        status = project.get("status")
        if status == ProjectStatus.READY.value:
            return ChatState(
                name="graph_ready",
                project=project,
                available_actions=[
                    "status",
                    "ask",
                    "explain",
                    "diff",
                    "onboard",
                    "domain",
                    "rerun_analysis",
                    "open_dashboard",
                ],
            )
        if status == ProjectStatus.FAILED.value:
            return ChatState(
                name="analysis_failed",
                project=project,
                blockers=[str(project.get("last_error") or "").strip()],
                available_actions=["status", "rerun_analysis", "open_dashboard"],
            )
        return ChatState(
            name="project_selected_no_graph",
            project=project,
            available_actions=["start_analysis", "open_dashboard"],
        )


class ChatStateMachine:
    PUBLIC_STATES = PUBLIC_STATES

    def validate(self, state: ChatState, intent: ChatIntent) -> ChatValidation:
        if state.name.startswith("blocked_") and intent.intent in START_INTENTS:
            reason = (
                "；".join(item for item in state.blockers if item) or "当前环境未就绪"
            )
            return ChatValidation(False, reason)
        if state.name == "analysis_running" and intent.intent in START_INTENTS:
            return ChatValidation(
                False, "已经有分析任务在运行，请先查看状态或停止当前任务。"
            )
        if state.name == "source_preparing" and intent.intent in START_INTENTS:
            return ChatValidation(
                False, "项目源码正在准备中，请先查看状态或停止当前任务。"
            )
        if state.name == "no_project" and intent.intent in CONTENT_INTENTS:
            return ChatValidation(
                False,
                "还没有可用项目，请先发送 `/understand 分析 <项目路径或 GitHub 地址>`。",
            )
        if state.name == "ambiguous_project" and intent.intent in CONTENT_INTENTS:
            return ChatValidation(False, "当前匹配到多个项目，请先说明要使用哪个项目。")
        if state.name != "graph_ready" and intent.intent in CONTENT_INTENTS:
            return ChatValidation(False, "当前项目图谱还未就绪，请先完成项目分析。")
        return ChatValidation(True)


class ChatActionExecutor:
    def __init__(self, runner: Any) -> None:
        self.runner = runner

    async def execute(
        self,
        intent: ChatIntent,
        *,
        event: Any,
        project_kwargs: dict[str, Any] | None = None,
    ) -> str:
        project_kwargs = dict(project_kwargs or {})
        if intent.intent == "status":
            return self.runner.format_job_status(
                intent.project_hint or _project_ref_from_kwargs(project_kwargs),
            )
        if intent.intent == "open_dashboard":
            return f"打开 AstrBot WebUI，进入插件 `{PLUGIN_NAME}`，然后打开 Dashboard 页面。"
        if intent.intent == "diagnose":
            return ToolResultPresenter(self.runner).project_state(intent.project_hint)
        if intent.intent == "repair_runtime":
            payload = await self.runner.runtime.repair()
            return (
                "修复完成。"
                if payload.get("ready")
                else "修复已执行，但运行环境仍未就绪。"
            )
        if intent.intent == "stop_job":
            return self._stop_latest_active_job()
        if intent.intent in START_INTENTS:
            await self._apply_ignore_options(intent, project_kwargs)
            job = await self._start_analysis(intent, event, project_kwargs)
            return self.runner.format_job_source_started_message(job)
        if intent.intent == "ask":
            return str(
                await self.runner.chat(
                    query=intent.query,
                    **_content_project_kwargs(project_kwargs, intent),
                    event=event,
                )
            )
        if intent.intent == "explain":
            return str(
                await self.runner.explain(
                    target=intent.target or intent.query,
                    **_content_project_kwargs(project_kwargs, intent),
                    event=event,
                )
            )
        if intent.intent == "diff":
            return str(
                await self.runner.diff(
                    **_content_project_kwargs(project_kwargs, intent),
                    event=event,
                )
            )
        if intent.intent == "onboard":
            return str(
                await self.runner.onboard(
                    **_content_project_kwargs(project_kwargs, intent),
                    event=event,
                )
            )
        if intent.intent == "domain":
            job = await self.runner.start_skill_job(
                skill_name="understand-domain",
                job_label="domain analysis",
                event=event,
                project_ref=intent.project_hint
                or _project_ref_from_kwargs(project_kwargs),
            )
            return self.runner.format_job_source_started_message(
                job,
                job_label="domain analysis",
            )
        if intent.intent == "select_project":
            return f"已切换项目上下文：{intent.project_hint}"
        if intent.intent == "legacy_removed":
            return (
                "旧子指令入口已移除。请直接用自然语言描述任务，例如："
                "`/understand 状态`、`/understand 分析 <项目路径或 GitHub 地址>`。"
            )
        return "我没有识别这个操作。你可以说：状态、分析项目、停止、打开面板、诊断、修复、解释文件或查看当前改动。"

    async def _start_analysis(
        self,
        intent: ChatIntent,
        event: Any,
        project_kwargs: dict[str, Any],
    ) -> JobSnapshot:
        source = str(intent.source or "").strip()
        kwargs: dict[str, Any] = {"skill_name": "understand", "event": event}
        if source:
            if GitHubRepoManager.looks_like_github_url(source):
                kwargs["repo_url"] = source
            else:
                kwargs["project_path"] = source
        else:
            kwargs.update(_content_project_kwargs(project_kwargs, intent))
        return await self.runner.start_skill_job(**kwargs)

    async def _apply_ignore_options(
        self,
        intent: ChatIntent,
        project_kwargs: dict[str, Any],
    ) -> None:
        patterns = intent.options.get("ignore")
        if not isinstance(patterns, list) or not patterns:
            return
        graph_root = _graph_root_for_options(self.runner, intent, project_kwargs)
        if graph_root is None:
            return
        append_ignore_patterns(graph_root, [str(item) for item in patterns])

    def _stop_latest_active_job(self) -> str:
        job = _latest_active_job(self.runner)
        if job is None:
            return "当前没有运行中的分析任务。"
        tasks = getattr(self.runner, "_tasks", {})
        task = tasks.get(job.job_id) if isinstance(tasks, dict) else None
        if task is not None and hasattr(task, "cancel") and not task.done():
            task.cancel()
        self.runner.jobs.mark_cancelled(job.job_id, "User stopped the job from chat.")
        return "已停止当前分析任务。"


class ToolResultPresenter:
    def __init__(self, runner: Any) -> None:
        self.runner = runner
        self.state_resolver = ChatStateResolver(runner)

    def project_state(self, project_hint: str = "") -> str:
        state = self.state_resolver.resolve(project_hint)
        return _json(
            {
                "state": state.name,
                "project": state.project,
                "active_job": state.running_job,
                "running_job": state.running_job,
                "blockers": [item for item in state.blockers if item],
                "available_actions": state.available_actions,
                "dashboard_url": _dashboard_url(),
                "llm_used": False,
            }
        )

    async def project_action(
        self,
        action: str,
        *,
        event: Any,
        project_hint: str = "",
        source: str = "",
        options: str = "",
        project_kwargs: dict[str, Any] | None = None,
    ) -> str:
        normalized_action = _normalize_tool_action(action)
        if normalized_action not in TOOL_ACTION_INTENTS:
            return _json(
                {
                    "status": "error",
                    "action": str(action or "").strip(),
                    "message": (
                        "内容类请求不能通过 ua_project_action 执行；"
                        "请先调用 ua_retrieve_project_context 获取上下文。"
                    ),
                    "llm_used": False,
                }
            )
        intent = ChatIntent(
            intent=normalized_action,
            project_hint=project_hint,
            source=source,
            options=_options_from_text(options),
        )
        state_before = ChatStateResolver(self.runner).resolve(
            project_hint,
            intent=intent,
            event=event,
        )
        validation = ChatStateMachine().validate(
            state_before,
            intent,
        )
        if not validation.allowed:
            return _json(
                {
                    "status": "blocked",
                    "action": intent.intent,
                    "message": validation.message,
                    "job": state_before.running_job,
                    "project": state_before.project,
                    "next_actions": state_before.available_actions,
                    "dashboard_url": _dashboard_url(),
                    "llm_used": False,
                }
            )
        message = await ChatActionExecutor(self.runner).execute(
            intent,
            event=event,
            project_kwargs=project_kwargs or {},
        )
        state_after = ChatStateResolver(self.runner).resolve(project_hint)
        return _json(
            {
                "status": "ok",
                "action": intent.intent,
                "message": message,
                "job": state_after.running_job,
                "project": state_after.project,
                "next_actions": state_after.available_actions,
                "dashboard_url": _dashboard_url(),
                "llm_used": False,
            }
        )

    def retrieve_project_context(
        self,
        query: str,
        *,
        project_hint: str = "",
        target: str = "",
        mode: str = "ask",
        project_kwargs: dict[str, Any] | None = None,
    ) -> str:
        kwargs = _content_project_kwargs(
            project_kwargs or {}, ChatIntent(project_hint=project_hint, intent="ask")
        )
        if project_hint:
            kwargs["project_ref"] = project_hint
        try:
            store = self.runner.project_store(**kwargs)
            graph = store.read_json("knowledge-graph.json")
        except Exception as exc:
            return _json({"status": "error", "error": str(exc), "llm_used": False})
        nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
        refs = _matching_graph_refs(nodes, query=query, target=target)
        files = sorted(
            {
                str(ref.get("filePath") or "")
                for ref in refs
                if str(ref.get("filePath") or "").strip()
            }
        )
        snippets = [
            {
                "filePath": ref.get("filePath"),
                "name": ref.get("name"),
                "summary": ref.get("summary"),
            }
            for ref in refs
        ]
        graph_summary = {
            "project": graph.get("project") if isinstance(graph, dict) else {},
            "node_count": len(nodes) if isinstance(nodes, list) else 0,
            "edge_count": len(graph.get("edges", [])) if isinstance(graph, dict) else 0,
        }
        return _json(
            {
                "status": "ok",
                "mode": mode or "ask",
                "query": query,
                "target": target,
                "refs": refs,
                "references": refs,
                "nodes": refs,
                "files": files,
                "snippets": snippets,
                "graph_summary": graph_summary,
                "graph": graph_summary,
                "confidence": min(1.0, len(refs) / 3) if refs else 0.0,
                "llm_used": False,
            }
        )


class UnderstandAnythingChatEntry:
    def __init__(self, runner: Any) -> None:
        self.runner = runner
        self.parser = ChatCommandParser()
        self.state_resolver = ChatStateResolver(runner)
        self.state_machine = ChatStateMachine()
        self.lightweight_parser = LightweightIntentParser(runner)
        self.executor = ChatActionExecutor(runner)
        self.tools = ToolResultPresenter(runner)

    async def execute_text(
        self,
        text: str,
        *,
        event: Any,
        project_kwargs: dict[str, Any] | None = None,
    ) -> str:
        project_kwargs = dict(project_kwargs or {})
        intent = self.parser.parse(text)
        state = self.state_resolver.resolve(
            intent.project_hint or _project_ref_from_kwargs(project_kwargs),
            intent=intent,
            event=event,
        )
        if intent.requires_lightweight_llm:
            intent = await self.lightweight_parser.parse(text, state=state, event=event)
            state = self.state_resolver.resolve(
                intent.project_hint or _project_ref_from_kwargs(project_kwargs),
                intent=intent,
                event=event,
            )
        validation = self.state_machine.validate(state, intent)
        if not validation.allowed:
            return validation.message
        return await self.executor.execute(
            intent,
            event=event,
            project_kwargs=project_kwargs,
        )


def _strip_understand_prefix(text: str) -> str:
    raw = str(text or "").strip()
    for prefix in ("/understand", "understand"):
        if raw == prefix:
            return ""
        if raw.startswith(f"{prefix} "):
            return raw[len(prefix) :].strip()
    return raw


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())


def _legacy_subcommand(text: str) -> str:
    parts = str(text or "").strip().split(maxsplit=1)
    if not parts:
        return ""
    first = parts[0].casefold()
    return first if first in LEGACY_SUBCOMMANDS else ""


def _source_after_prefix(text: str, prefixes: tuple[str, ...]) -> str:
    raw = str(text or "").strip()
    for prefix in prefixes:
        if raw.startswith(prefix):
            return raw[len(prefix) :].strip(" ：:\t")
    return ""


def _looks_like_analysis_source(text: str) -> bool:
    value = str(text or "").strip()
    if not value:
        return False
    if GitHubRepoManager.looks_like_github_url(value):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", value):
        return True
    if value.startswith(("/", "./", "../", "~")):
        return True
    if any(separator in value for separator in ("\\", "/")) and " " not in value:
        return True
    return False


def _options_from_text(text: str) -> dict[str, Any]:
    raw = str(text or "").strip()
    if not raw:
        return {}
    ignore_match = re.search(r"(?:忽略|排除)\s+(.+)$", raw)
    if not ignore_match:
        return {}
    cleaned = ignore_match.group(1).replace("，", " ").replace(",", " ")
    return {"ignore": [item for item in cleaned.split() if item]}


def _text_without_options(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    return re.split(r"[，,\s]*(?:忽略|排除)\s+", raw, maxsplit=1)[0].strip(" ，,\t")


def _latest_active_job(runner: Any) -> JobSnapshot | None:
    jobs = getattr(getattr(runner, "jobs", None), "list", lambda: [])()
    return next((job for job in jobs if job.status in ACTIVE_JOB_STATUSES), None)


def _latest_failed_job(runner: Any) -> JobSnapshot | None:
    jobs = getattr(getattr(runner, "jobs", None), "list", lambda: [])()
    return next((job for job in jobs if job.status is JobStatus.FAILED), None)


def _project_records(runner: Any) -> list[Any]:
    registry = getattr(runner, "registry", None)
    list_projects = getattr(registry, "list", None)
    if not callable(list_projects):
        return []
    return list(list_projects())


def _select_project(projects: list[Any], project_hint: str) -> Any:
    if project_hint:
        normalized = project_hint.casefold()
        matches = [
            project
            for project in projects
            if normalized
            in {
                str(getattr(project, "project_id", "")).casefold(),
                str(getattr(project, "name", "")).casefold(),
                str(getattr(project, "path", "")).casefold(),
                str(Path(str(getattr(project, "path", ""))).name).casefold(),
            }
            or normalized
            in {
                str(alias).casefold()
                for alias in (getattr(project, "aliases", None) or [])
            }
        ]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            return "ambiguous"
        return None
    if len(projects) == 1:
        return projects[0]
    if len(projects) > 1:
        return "ambiguous"
    return None


def _start_blocker_state(
    runner: Any,
    intent: ChatIntent,
    event: Any,
) -> ChatState | None:
    runtime_blockers = _runtime_blockers(runner, intent)
    if runtime_blockers:
        return ChatState(
            name="blocked_runtime",
            blockers=runtime_blockers,
            available_actions=["diagnose", "repair_runtime", "open_dashboard"],
        )
    subagent_blockers = _subagent_blockers(runner)
    if subagent_blockers:
        return ChatState(
            name="blocked_subagents",
            blockers=subagent_blockers,
            available_actions=["diagnose", "open_dashboard"],
        )
    computer_use_blockers = _computer_use_blockers(runner, event)
    if computer_use_blockers:
        return ChatState(
            name="blocked_computer_use",
            blockers=computer_use_blockers,
            available_actions=["diagnose", "open_dashboard"],
        )
    return None


def _runtime_blockers(runner: Any, intent: ChatIntent) -> list[str]:
    runtime = getattr(runner, "runtime", None)
    tools_fn = getattr(runtime, "tools", None)
    tools = tools_fn() if callable(tools_fn) else detect_runtime_tools()
    config = getattr(runner, "config", {}) or {}
    readiness = runtime_readiness(
        UNDERSTAND_ANYTHING_ROOT,
        tools,
        auto_repair_enabled=bool(config.get("auto_build", True)),
    )
    github_source = GitHubRepoManager.looks_like_github_url(str(intent.source or ""))
    if github_source:
        if readiness.get("github_analysis_ready"):
            return []
        reason = str(readiness.get("github_blocking_reason") or "").strip()
        if reason:
            return [reason]
    elif readiness.get("local_analysis_ready"):
        return []
    reasons = readiness.get("blocking_reasons")
    if isinstance(reasons, list):
        return [str(item).strip() for item in reasons if str(item).strip()]
    return ["插件运行依赖未就绪"]


def _subagent_blockers(runner: Any) -> list[str]:
    context = getattr(runner, "context", None)
    if context is None:
        return []
    try:
        registry_cls = _subagent_registry_cls()
        status = registry_cls(
            context,
            getattr(runner, "config", {}) or {},
        ).status_payload()
    except Exception as exc:
        return [f"SubAgent 状态检查失败：{exc}"]
    if status.get("ready"):
        return []
    roles = sorted(
        {
            str(item)
            for key in ("missing_roles", "stale_roles", "unloaded_roles")
            for item in status.get(key, []) or []
            if str(item).strip()
        }
    )
    if roles:
        return [f"SubAgent 未就绪：{', '.join(roles)}"]
    error = str(status.get("error") or "").strip()
    return [f"SubAgent 未就绪：{error or '请在 Dashboard 注册 UA SubAgents'}"]


def _subagent_registry_cls() -> Any:
    global UnderstandAnythingSubAgentRegistry
    if UnderstandAnythingSubAgentRegistry is None:
        from .subagent_registry import (
            UnderstandAnythingSubAgentRegistry as registry_cls,
        )

        UnderstandAnythingSubAgentRegistry = registry_cls
    return UnderstandAnythingSubAgentRegistry


def _computer_use_blockers(runner: Any, event: Any) -> list[str]:
    context = getattr(runner, "context", None)
    if context is None:
        return []
    status = computer_use_status(
        context,
        umo=getattr(event, "unified_msg_origin", None) if event is not None else None,
    )
    if status.get("enabled"):
        return []
    reason = str(status.get("blocking_reason") or "").strip()
    return [reason or "Computer Use 未启用"]


def _job_payload(job: JobSnapshot) -> dict[str, Any]:
    return {
        "id": job.job_id,
        "status": job.status.value,
        "phase": job.progress.phase,
        "percent": job.progress.percent,
        "project": job.args.get("project_display_name") or job.project_root.name,
    }


def _project_candidates(runner: Any) -> list[str]:
    return [
        str(getattr(project, "name", "") or getattr(project, "project_id", ""))
        for project in _project_records(runner)
    ]


def _project_ref_from_kwargs(project_kwargs: dict[str, Any]) -> str:
    for key in ("project_ref", "project_id", "project_name", "project_path"):
        value = project_kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _content_project_kwargs(
    project_kwargs: dict[str, Any],
    intent: ChatIntent,
) -> dict[str, Any]:
    kwargs = dict(project_kwargs)
    if intent.project_hint:
        kwargs = {"project_ref": intent.project_hint}
    return kwargs


def _normalize_tool_action(action: str) -> str:
    normalized = str(action or "").strip()
    return {
        "status": "status",
        "refresh_status": "status",
        "start": "start_analysis",
        "start_analysis": "start_analysis",
        "start_github_analysis": "start_analysis",
        "rerun": "rerun_analysis",
        "rerun_analysis": "rerun_analysis",
        "stop": "stop_job",
        "stop_job": "stop_job",
        "select_project": "select_project",
        "open_dashboard": "open_dashboard",
        "diagnose": "diagnose",
        "repair": "repair_runtime",
        "repair_runtime": "repair_runtime",
    }.get(normalized, normalized)


def _graph_root_for_options(
    runner: Any,
    intent: ChatIntent,
    project_kwargs: dict[str, Any],
) -> Path | None:
    ref = intent.project_hint or _project_ref_from_kwargs(project_kwargs)
    registry = getattr(runner, "registry", None)
    get_project = getattr(registry, "get", None)
    if callable(get_project):
        record = get_project(project_ref=ref) if ref else get_project()
        graph_root = getattr(record, "graph_root", "") if record is not None else ""
        if graph_root:
            return Path(str(graph_root))
    job = _latest_active_job(runner) or _latest_failed_job(runner)
    if job is not None:
        graph_root = job.args.get("graph_root")
        if graph_root:
            return Path(str(graph_root))
    return None


def _matching_graph_refs(
    nodes: Any,
    *,
    query: str,
    target: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    if not isinstance(nodes, list):
        return []
    terms = [
        item.casefold()
        for item in re.split(r"\W+", f"{query} {target}")
        if len(item.strip()) >= 2
    ]
    matches: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        haystack = " ".join(
            str(node.get(key) or "")
            for key in ("id", "name", "filePath", "summary", "type")
        ).casefold()
        if terms and not any(term in haystack for term in terms):
            continue
        matches.append(
            {
                "id": node.get("id"),
                "name": node.get("name"),
                "type": node.get("type"),
                "filePath": node.get("filePath"),
                "summary": node.get("summary"),
            }
        )
        if len(matches) >= limit:
            break
    return matches


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _dashboard_url() -> str:
    return f"plugin:{PLUGIN_NAME}/dashboard"
