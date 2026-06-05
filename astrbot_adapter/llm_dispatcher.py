from __future__ import annotations

from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent
from astrbot.core.agent.tool import ToolSet
from astrbot.core.star import Context
from astrbot.core.tools.computer_tools import (
    ExecuteShellTool,
    FileDownloadTool,
    FileEditTool,
    FileReadTool,
    FileUploadTool,
    FileWriteTool,
    GrepTool,
    LocalPythonTool,
    PythonTool,
)

from .constants import UA_TOOL_CALL_TIMEOUT_SECONDS


class LLMDispatcher:
    def __init__(self, context: Context, provider_id: str = "") -> None:
        self.context = context
        self.provider_id = provider_id

    async def generate(
        self,
        *,
        prompt: str,
        event: AstrMessageEvent | None = None,
        system_prompt: str = "",
    ) -> str:
        provider_id = await self._provider_id(event)
        resp = await self.context.llm_generate(
            chat_provider_id=provider_id,
            prompt=prompt,
            system_prompt=system_prompt,
        )
        return resp.completion_text or ""

    async def run_with_local_tools(
        self,
        *,
        event: AstrMessageEvent,
        prompt: str,
        system_prompt: str,
        max_steps: int = 80,
        extra_tools: ToolSet | None = None,
    ) -> str:
        provider_id = await self._provider_id(event)
        resp = await self.context.tool_loop_agent(
            event=event,
            chat_provider_id=provider_id,
            prompt=prompt,
            system_prompt=system_prompt,
            tools=self.tool_set_for_event(event, extra_tools),
            max_steps=max_steps,
            tool_call_timeout=UA_TOOL_CALL_TIMEOUT_SECONDS,
        )
        return resp.completion_text or ""

    async def _provider_id(self, event: AstrMessageEvent | None) -> str:
        if self.provider_id:
            return self.provider_id
        if event is not None:
            try:
                return await self.context.get_current_chat_provider_id(
                    event.unified_msg_origin,
                )
            except Exception as exc:
                logger.warning("Failed to resolve current provider id: %s", exc)
        provider = self.context.get_using_provider()
        if provider:
            return provider.meta().id
        raise RuntimeError("No AstrBot chat provider is available.")

    def tool_set_for_event(
        self,
        event: AstrMessageEvent,
        extra_tools: ToolSet | None = None,
    ) -> ToolSet:
        tool_set = ToolSet()
        tool_mgr = self.context.get_llm_tool_manager()
        for tool_cls in self._computer_tool_classes(event):
            tool = tool_mgr.get_builtin_tool(tool_cls)
            if tool is not None:
                tool_set.add_tool(tool)
        if extra_tools is not None:
            tool_set.merge(extra_tools)
        return tool_set

    def _computer_tool_classes(self, event: AstrMessageEvent) -> tuple[type, ...]:
        if self._computer_use_runtime(event) == "sandbox":
            return (
                ExecuteShellTool,
                PythonTool,
                FileUploadTool,
                FileDownloadTool,
                FileReadTool,
                FileWriteTool,
                FileEditTool,
                GrepTool,
            )
        return (
            ExecuteShellTool,
            LocalPythonTool,
            FileReadTool,
            FileWriteTool,
            FileEditTool,
            GrepTool,
        )

    def _computer_use_runtime(self, event: AstrMessageEvent) -> str:
        try:
            config = self.context.get_config(
                umo=getattr(event, "unified_msg_origin", None),
            )
        except Exception:
            try:
                config = self.context.get_config()
            except Exception:
                config = {}
        provider_settings = (
            config.get("provider_settings", {})
            if hasattr(config, "get")
            else {}
        )
        return str(provider_settings.get("computer_use_runtime") or "none")


def read_prompt_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")
