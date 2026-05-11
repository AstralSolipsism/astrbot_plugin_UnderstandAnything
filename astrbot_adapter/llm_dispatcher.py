from __future__ import annotations

from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent
from astrbot.core.agent.tool import ToolSet
from astrbot.core.star import Context
from astrbot.core.tools.computer_tools import (
    ExecuteShellTool,
    FileEditTool,
    FileReadTool,
    FileWriteTool,
    GrepTool,
    LocalPythonTool,
)


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
    ) -> str:
        provider_id = await self._provider_id(event)
        resp = await self.context.tool_loop_agent(
            event=event,
            chat_provider_id=provider_id,
            prompt=prompt,
            system_prompt=system_prompt,
            tools=self._local_tool_set(),
            max_steps=max_steps,
            tool_call_timeout=300,
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

    def _local_tool_set(self) -> ToolSet:
        tool_set = ToolSet()
        tool_mgr = self.context.get_llm_tool_manager()
        for tool_cls in (
            ExecuteShellTool,
            LocalPythonTool,
            FileReadTool,
            FileWriteTool,
            FileEditTool,
            GrepTool,
        ):
            tool = tool_mgr.get_builtin_tool(tool_cls)
            if tool is not None:
                tool_set.add_tool(tool)
        return tool_set


def read_prompt_file(path: Path) -> str:
    return path.read_text(encoding="utf-8")
