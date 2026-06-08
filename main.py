from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.star.filter.command import GreedyStr

from .astrbot_adapter.chat_entry import UnderstandAnythingChatEntry
from .astrbot_adapter.runner import UnderstandAnythingRunner
from .astrbot_adapter.web_api import UnderstandAnythingWebApi


UNDERSTAND_GROUP_SUBCOMMANDS = (
    "状态",
    "项目",
    "检查更新",
    "分析",
    "更新",
    "更新图谱",
    "重新分析",
    "停止",
    "诊断",
    "修复",
    "面板",
)
UA_OUTER_LLM_TOOLS = {
    "ua_get_project_state",
    "ua_select_project_context",
    "ua_project_action",
    "ua_retrieve_project_context",
}
UA_TOOL_ROUTING_PROMPT_MARKER = "# Understand Anything Tool Routing"
UA_TOOL_ROUTING_PROMPT = """

# Understand Anything Tool Routing

For project, codebase, architecture, domain, diff, onboarding, or repository questions:
- First call `ua_get_project_state` to check whether an Understand Anything graph already exists.
- If state is `graph_ready` or `graph_stale`, call `ua_retrieve_project_context` and answer from the returned graph context unless the user is asking to update the graph.
- If the user explicitly switches projects or says future questions should use a project, call `ua_select_project_context`.
- For cross-project comparison, do not switch context; call `ua_get_project_state` and `ua_retrieve_project_context` separately for each named project.
- If multiple projects are registered and the user did not identify one, ask which project instead of guessing.
- If retrieval returns `project_selection_required`, ask the user to choose a project. Do not answer from another project.
- Do not call `ua_project_action` with `start_analysis` just to answer a question.
- Use `check_updates` only when the user asks to check whether a registered project has updates; it is a read-only freshness check and must not start analysis.
- Use `start_analysis` only when the user provides a new local path or GitHub URL and asks to analyze it.
- Use `update_analysis` when the user asks to update or refresh an already analyzed project graph to the current source state.
- Use `rerun_analysis` only when the user explicitly asks for full reanalysis, rerun, or rebuild analysis.
- If a tool reports `already_analyzed`, do not start analysis; retrieve context instead.
"""


class UnderstandAnythingPlugin(Star):
    def __init__(
        self,
        context: Context,
        config: AstrBotConfig | dict | None = None,
    ) -> None:
        super().__init__(context)
        self.config = dict(config or {})
        self.runner = UnderstandAnythingRunner(context, self.config)
        self.web_api = UnderstandAnythingWebApi(context, self.runner)
        self.webchat_context_store = self.web_api.webchat_proxy.context_store
        self.chat_entry = UnderstandAnythingChatEntry(
            self.runner,
            context_store=self.webchat_context_store,
        )
        self.web_api.register()

    async def initialize(self) -> None:
        await self.runner.initialize()
        logger.info("Understand Anything plugin initialized.")

    async def terminate(self) -> None:
        await self.runner.terminate()
        logger.info("Understand Anything plugin terminated.")

    @filter.command_group("understand")
    def understand_commands(self):
        """Understand Anything 指令组。"""
        pass

    @understand_commands.command("状态")
    async def understand_status(self, event: AstrMessageEvent, project: GreedyStr = ""):
        """查看分析状态。"""
        yield await self._run_understand_text(event, self._command_text("状态", project))

    @understand_commands.command("项目")
    async def understand_project(self, event: AstrMessageEvent, project: GreedyStr = ""):
        """查看或切换当前项目。"""
        yield await self._run_understand_text(event, self._command_text("项目", project))

    @understand_commands.command("停止")
    async def understand_stop(self, event: AstrMessageEvent):
        """停止当前分析任务。"""
        yield await self._run_understand_text(event, "停止")

    @understand_commands.command("诊断")
    async def understand_diagnose(self, event: AstrMessageEvent):
        """检查插件运行环境。"""
        yield await self._run_understand_text(event, "诊断")

    @understand_commands.command("修复")
    async def understand_repair(self, event: AstrMessageEvent):
        """修复插件运行依赖。"""
        yield await self._run_understand_text(event, "修复")

    @understand_commands.command("分析")
    async def understand_analyze(self, event: AstrMessageEvent, source: GreedyStr = ""):
        """分析本地项目或 GitHub 仓库。"""
        yield await self._run_understand_text(event, self._command_text("分析", source))

    @understand_commands.command("检查更新")
    async def understand_check_updates(
        self,
        event: AstrMessageEvent,
        project: GreedyStr = "",
    ):
        """检查已有项目是否有更新。"""
        yield await self._run_understand_text(
            event,
            self._command_text("检查更新", project),
        )

    @understand_commands.command("更新")
    async def understand_update(self, event: AstrMessageEvent, project: GreedyStr = ""):
        """更新已有项目图谱。"""
        yield await self._run_understand_text(
            event,
            self._command_text("更新", project),
        )

    @understand_commands.command("更新图谱")
    async def understand_update_graph(
        self,
        event: AstrMessageEvent,
        project: GreedyStr = "",
    ):
        """更新已有项目图谱。"""
        yield await self._run_understand_text(
            event,
            self._command_text("更新图谱", project),
        )

    @understand_commands.command("重新分析")
    async def understand_rerun(self, event: AstrMessageEvent, project: GreedyStr = ""):
        """重新分析已有项目。"""
        yield await self._run_understand_text(
            event,
            self._command_text("重新分析", project),
        )

    @understand_commands.command("面板")
    async def understand_panel(self, event: AstrMessageEvent):
        """打开 Dashboard。"""
        yield await self._run_understand_text(event, "面板")

    @filter.command("understand")
    async def understand(self, event: AstrMessageEvent, task: GreedyStr = ""):
        """Understand Anything natural language entry."""
        text = str(task or "").strip() or self._args(event, "understand")
        yield await self._run_understand_text(event, text)

    @filter.on_llm_request()
    async def append_understand_anything_tool_routing(
        self,
        event: AstrMessageEvent,
        req: Any,
    ) -> None:
        """Append stable UA tool routing rules to LLM requests with UA tools."""
        if not _request_has_outer_ua_tools(req):
            return
        system_prompt = str(getattr(req, "system_prompt", "") or "")
        if UA_TOOL_ROUTING_PROMPT_MARKER in system_prompt:
            return
        req.system_prompt = f"{system_prompt}{UA_TOOL_ROUTING_PROMPT}"

    @filter.llm_tool(name="ua_get_project_state")
    async def ua_get_project_state(
        self,
        event: AstrMessageEvent,
        project_hint: str = "",
    ):
        """Always call this first for project/codebase questions.

        It is a cheap, read-only state check. Use it before answering project
        questions, before retrieving graph context, and before considering any
        analysis action. If it returns graph_ready, retrieve context instead of
        starting analysis.

        Args:
            project_hint(string): Optional project name, id, alias, or path.
        """
        hint = project_hint or self._effective_status_project_ref(event)
        return self.chat_entry.tools.project_state(hint or "")

    @filter.llm_tool(name="ua_select_project_context")
    async def ua_select_project_context(
        self,
        event: AstrMessageEvent,
        project_hint: str,
    ):
        """Switch the current chat session to a clearly named project.

        Use this only when the user explicitly says to switch projects, use a
        project for future questions, or names one unique project in the
        current question. Do not use it for cross-project comparison; retrieve
        each named project temporarily instead.

        Args:
            project_hint(string): Project name, id, alias, path, or GitHub repo.
        """
        return self.chat_entry.tools.select_project_context(
            project_hint,
            event=event,
        )

    @filter.llm_tool(name="ua_project_action")
    async def ua_project_action(
        self,
        event: AstrMessageEvent,
        action: str,
        project_hint: str = "",
        source: str = "",
        options: str = "",
        user_explicit_rerun: bool = False,
    ):
        """Project management only; not for answering code questions.

        High-cost actions are guarded. Do not use start_analysis for a project
        that already has graph_ready or graph_stale state. Use check_updates
        only for a read-only freshness check. Use update_analysis for the
        normal update of an already analyzed project graph. Do not use
        rerun_analysis unless the user explicitly asked for full reanalysis,
        rerun, or rebuild; set user_explicit_rerun true only in that case.
        For normal questions, call ua_get_project_state first and then
        ua_retrieve_project_context.

        Args:
            action(string): One of status, check_updates, start_analysis,
                start_github_analysis, update_analysis, stop, rerun,
                select_project, diagnose, repair, open_dashboard.
            project_hint(string): Optional project name, id, alias, or path.
            source(string): Optional local project path or GitHub URL.
            options(string): Optional action options such as ignored paths.
            user_explicit_rerun(boolean): True only when the user explicitly
                requested full rerun/reanalysis/rebuild in the current turn.
        """
        return await self.chat_entry.tools.project_action(
            action,
            event=event,
            project_hint=project_hint,
            source=source,
            options=options,
            user_explicit_rerun=bool(user_explicit_rerun),
            project_kwargs=self._effective_project_kwargs(event, project_hint),
        )

    @filter.llm_tool(name="ua_retrieve_project_context")
    async def ua_retrieve_project_context(
        self,
        event: AstrMessageEvent,
        query: str,
        project_hint: str = "",
        target: str = "",
        mode: str = "ask",
    ):
        """Primary tool for answering project/codebase questions.

        Use after ua_get_project_state reports graph_ready. This is read-only
        and must be preferred over starting analysis when the project was
        already analyzed in Dashboard or WebChat.

        Args:
            query(string): User question or retrieval query.
            project_hint(string): Optional project name, id, alias, or path.
            target(string): Optional file path, symbol, or component target.
            mode(string): ask, explain, diff, onboard, or domain.
        """
        return self.chat_entry.tools.retrieve_project_context(
            query,
            project_hint=project_hint,
            target=target,
            mode=mode,
            project_kwargs=self._effective_project_kwargs(event, project_hint),
        )

    @staticmethod
    def _args(event: AstrMessageEvent, *command_names: str) -> str:
        message = event.get_message_str().strip()
        for command_name in command_names:
            for prefix in (command_name, f"/{command_name}"):
                if message == prefix:
                    return ""
                if message.startswith(f"{prefix} "):
                    return message[len(prefix) :].strip()
        return event.message_str.strip()

    async def _run_understand_text(self, event: AstrMessageEvent, text: str):
        message = await self.chat_entry.execute_text(
            str(text or "").strip(),
            event=event,
            project_kwargs=self._effective_project_kwargs(event),
        )
        event.stop_event()
        return event.plain_result(message)

    @staticmethod
    def _command_text(command: str, payload: str = "") -> str:
        payload_text = str(payload or "").strip()
        return f"{command} {payload_text}".strip()

    def _first_path_arg(
        self, event: AstrMessageEvent, *command_names: str
    ) -> str | None:
        raw_args = self._args(event, *command_names)
        return self._first_path_token(raw_args)

    def _effective_project_kwargs(
        self,
        event: AstrMessageEvent,
        explicit_project: str = "",
    ) -> dict[str, Any]:
        webchat_context = self._webchat_context_for_event(event)
        context_items = webchat_context.get("context_items")
        explicit = str(explicit_project or "").strip()
        if explicit:
            kwargs: dict[str, Any] = {"project_ref": explicit}
            if isinstance(context_items, list) and context_items:
                kwargs["context_items"] = context_items
            return kwargs
        project_ref = webchat_context.get("project_ref")
        if not isinstance(project_ref, dict) or not project_ref:
            return {"project_ref": None}
        kwargs: dict[str, Any] = {}
        for key in ("project_id", "project_name", "project_path"):
            value = project_ref.get(key)
            if isinstance(value, str) and value.strip():
                kwargs[key] = value.strip()
        ref = project_ref.get("project_ref") or project_ref.get("project")
        if isinstance(ref, str) and ref.strip():
            kwargs["project_ref"] = ref.strip()
        if not kwargs:
            kwargs["project_ref"] = None
        if isinstance(context_items, list) and context_items:
            kwargs["context_items"] = context_items
        return kwargs

    def _effective_status_project_ref(
        self,
        event: AstrMessageEvent,
        explicit_project: str = "",
    ) -> str | None:
        explicit = str(explicit_project or "").strip()
        if explicit:
            return explicit
        project_kwargs = self._effective_project_kwargs(event)
        for key in ("project_ref", "project_id", "project_name", "project_path"):
            value = project_kwargs.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _webchat_project_ref_for_event(
        self,
        event: AstrMessageEvent,
    ) -> dict[str, Any]:
        project_ref = self._webchat_context_for_event(event).get("project_ref")
        return project_ref if isinstance(project_ref, dict) else {}

    def _webchat_context_for_event(
        self,
        event: AstrMessageEvent,
    ) -> dict[str, Any]:
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        context_for_umo = getattr(self.webchat_context_store, "context_for_umo", None)
        if callable(context_for_umo):
            context = context_for_umo(umo)
            return context if isinstance(context, dict) else {}
        project_ref = self.webchat_context_store.project_ref_for_umo(umo)
        return {"project_ref": project_ref} if isinstance(project_ref, dict) else {}

    @staticmethod
    def _parse_project_option(raw_args: str) -> tuple[str | None, str]:
        tokens = UnderstandAnythingPlugin._split_args(raw_args)
        project_ref: str | None = None
        remaining: list[str] = []
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token == "--project":
                if index + 1 >= len(tokens):
                    raise ValueError("Missing value for --project.")
                project_ref = tokens[index + 1]
                index += 2
                continue
            if token.startswith("--project="):
                project_ref = token.split("=", 1)[1].strip()
                index += 1
                continue
            remaining.append(token)
            index += 1
        return project_ref, " ".join(remaining).strip()

    @staticmethod
    def _project_selector_from_args(raw_args: str) -> tuple[str | None, str | None]:
        project_ref, remaining = UnderstandAnythingPlugin._parse_project_option(
            raw_args
        )
        return project_ref, UnderstandAnythingPlugin._first_path_token(remaining)

    @staticmethod
    def _first_path_token(raw_args: str) -> str | None:
        for token in UnderstandAnythingPlugin._split_args(raw_args):
            if token and not token.startswith("--"):
                return str(Path(token))
        return None

    @staticmethod
    def _split_args(raw_args: str) -> list[str]:
        try:
            tokens = shlex.split(raw_args, posix=False)
        except ValueError:
            tokens = raw_args.split()
        return [token.strip("\"'") for token in tokens if token.strip("\"'")]


def _request_has_outer_ua_tools(req: Any) -> bool:
    tool_set = getattr(req, "func_tool", None)
    names_fn = getattr(tool_set, "names", None)
    if not callable(names_fn):
        return False
    try:
        names = names_fn()
    except Exception:
        return False
    return any(str(name) in UA_OUTER_LLM_TOOLS for name in names or [])
