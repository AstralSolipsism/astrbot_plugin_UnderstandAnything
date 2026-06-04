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


class UnderstandAnythingPlugin(Star):
    def __init__(
        self,
        context: Context,
        config: AstrBotConfig | dict | None = None,
    ) -> None:
        super().__init__(context)
        self.config = dict(config or {})
        self.runner = UnderstandAnythingRunner(context, self.config)
        self.chat_entry = UnderstandAnythingChatEntry(self.runner)
        self.web_api = UnderstandAnythingWebApi(context, self.runner)
        self.webchat_context_store = self.web_api.webchat_proxy.context_store
        self.web_api.register()

    async def initialize(self) -> None:
        await self.runner.initialize()
        logger.info("Understand Anything plugin initialized.")

    async def terminate(self) -> None:
        await self.runner.terminate()
        logger.info("Understand Anything plugin terminated.")

    @filter.command("understand")
    async def understand(self, event: AstrMessageEvent, task: GreedyStr = ""):
        """Understand Anything natural language entry."""
        text = str(task or "").strip() or self._args(event, "understand")
        message = await self.chat_entry.execute_text(
            text,
            event=event,
            project_kwargs=self._effective_project_kwargs(event),
        )
        yield event.plain_result(message)

    @filter.llm_tool(name="ua_get_project_state")
    async def ua_get_project_state(
        self,
        event: AstrMessageEvent,
        project_hint: str = "",
    ):
        """Read Understand Anything project state for the outer AstrBot LLM.

        Args:
            project_hint(string): Optional project name, id, alias, or path.
        """
        hint = project_hint or self._effective_status_project_ref(event)
        return self.chat_entry.tools.project_state(hint or "")

    @filter.llm_tool(name="ua_project_action")
    async def ua_project_action(
        self,
        event: AstrMessageEvent,
        action: str,
        project_hint: str = "",
        source: str = "",
        options: str = "",
    ):
        """Execute a deterministic Understand Anything project action.

        Args:
            action(string): One of status, start_analysis, start_github_analysis,
                stop, rerun, diagnose, repair, open_dashboard.
            project_hint(string): Optional project name, id, alias, or path.
            source(string): Optional local project path or GitHub URL.
            options(string): Optional action options such as ignored paths.
        """
        return await self.chat_entry.tools.project_action(
            action,
            event=event,
            project_hint=project_hint,
            source=source,
            options=options,
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
        """Retrieve graph context for the outer AstrBot LLM.

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
