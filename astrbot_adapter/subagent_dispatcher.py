from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import mcp

from astrbot.core.agent.handoff import HandoffTool
from astrbot.core.agent.run_context import ContextWrapper
from astrbot.core.agent.tool import FunctionTool, ToolSet
from astrbot.core.astr_agent_context import AstrAgentContext
from astrbot.core.astr_agent_tool_exec import FunctionToolExecutor
from astrbot.core.message.components import Plain
from astrbot.core.platform.astr_message_event import AstrMessageEvent
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.star import Context

from .constants import PLUGIN_NAME
from .subagent_registry import ROLE_NAMES, UnderstandAnythingSubAgentRegistry

HandoffExecutor = Callable[
    [HandoffTool[AstrAgentContext], ContextWrapper[AstrAgentContext], dict[str, Any]],
    Awaitable[str],
]
LogFn = Callable[[str], None]


class UnderstandAnythingSubAgentDispatcher:
    """Dispatch UA role work through persisted AstrBot SubAgent handoff tools."""

    def __init__(
        self,
        context: Context,
        *,
        log_fn: LogFn | None = None,
        handoff_executor: HandoffExecutor | None = None,
    ) -> None:
        self.context = context
        self.log_fn = log_fn
        self.handoff_executor = handoff_executor or self._execute_handoff
        self._uses_custom_handoff_executor = handoff_executor is not None

    def tool_set(self) -> ToolSet:
        return ToolSet(
            [
                FunctionTool(
                    name="ua_run_subagent_role",
                    description=(
                        "Run one Understand Anything worker role as a real "
                        "AstrBot SubAgent and wait for its result."
                    ),
                    parameters={
                        "type": "object",
                        "properties": {
                            "role": {
                                "type": "string",
                                "enum": sorted(ROLE_NAMES),
                                "description": "Understand Anything role name.",
                            },
                            "input": {
                                "type": "string",
                                "description": "Complete task prompt for the role.",
                            },
                            "expected_output_path": {
                                "type": "string",
                                "description": (
                                    "Optional file path the role is expected to write."
                                ),
                            },
                        },
                        "required": ["role", "input"],
                    },
                    handler=self._tool_run_subagent_role,
                ),
                FunctionTool(
                    name="ua_run_subagent_batches",
                    description=(
                        "Run multiple Understand Anything worker batches as "
                        "real AstrBot SubAgents with bounded concurrency."
                    ),
                    parameters={
                        "type": "object",
                        "properties": {
                            "role": {
                                "type": "string",
                                "enum": sorted(ROLE_NAMES),
                                "description": "Understand Anything batch role name.",
                            },
                            "batches": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": {
                                            "type": "string",
                                            "description": "Stable batch identifier.",
                                        },
                                        "input": {
                                            "type": "string",
                                            "description": (
                                                "Complete task prompt for this batch."
                                            ),
                                        },
                                        "expected_output_path": {
                                            "type": "string",
                                            "description": (
                                                "Optional file path this batch writes."
                                            ),
                                        },
                                    },
                                    "required": ["input"],
                                },
                                "description": "Batch task list.",
                            },
                            "max_concurrency": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "Maximum simultaneous SubAgents.",
                            },
                            "continue_on_error": {
                                "type": "boolean",
                                "description": (
                                    "Continue other batches after a batch failure."
                                ),
                            },
                        },
                        "required": ["role", "batches"],
                    },
                    handler=self._tool_run_subagent_batches,
                ),
            ]
        )

    async def _tool_run_subagent_role(
        self,
        event: AstrMessageEvent,
        role: str,
        input: str,
        expected_output_path: str = "",
    ) -> str:
        result = await self.run_role(
            event,
            role=role,
            input_text=input,
            expected_output_path=expected_output_path,
        )
        return json.dumps(result, ensure_ascii=False)

    async def _tool_run_subagent_batches(
        self,
        event: AstrMessageEvent,
        role: str,
        batches: list[dict[str, Any]],
        max_concurrency: int = 1,
        continue_on_error: bool = True,
    ) -> str:
        result = await self.run_batches(
            event,
            role=role,
            batches=batches,
            max_concurrency=max_concurrency,
            continue_on_error=continue_on_error,
        )
        return json.dumps(result, ensure_ascii=False)

    async def run_role(
        self,
        event: AstrMessageEvent,
        *,
        role: str,
        input_text: str,
        expected_output_path: str = "",
        batch_id: str | None = None,
    ) -> dict[str, Any]:
        role = self._normalize_role(role)
        if not str(input_text).strip():
            raise ValueError("SubAgent input cannot be empty.")

        label = f"{role}:{batch_id}" if batch_id is not None else role
        self._log(f"SubAgent started: {label}")
        try:
            worker_event = self._worker_event(event, role, batch_id)
            handoff = await self._handoff_for_role(role)
            run_context = self._run_context(worker_event)
            text = await self.handoff_executor(
                handoff,
                run_context,
                {
                    "input": input_text,
                    "background_task": False,
                },
            )
            output = self._output_state(expected_output_path)
            status = (
                "ok" if not output["path"] or output["exists"] else "missing_output"
            )
            self._log(f"SubAgent finished: {label} status={status}")
            return {
                "role": role,
                "batch_id": batch_id,
                "status": status,
                "result": text,
                "output": output,
            }
        except Exception as exc:
            self._log(f"SubAgent failed: {label} error={exc}")
            return {
                "role": role,
                "batch_id": batch_id,
                "status": "failed",
                "error": str(exc),
                "output": self._output_state(expected_output_path),
            }

    async def run_batches(
        self,
        event: AstrMessageEvent,
        *,
        role: str,
        batches: list[dict[str, Any]],
        max_concurrency: int = 1,
        continue_on_error: bool = True,
    ) -> dict[str, Any]:
        role = self._normalize_role(role)
        if not isinstance(batches, list) or not batches:
            raise ValueError("SubAgent batches must be a non-empty list.")
        max_concurrency = max(1, int(max_concurrency or 1))
        semaphore = asyncio.Semaphore(max_concurrency)

        async def run_one(index: int, batch: dict[str, Any]) -> dict[str, Any]:
            if not isinstance(batch, dict):
                raise ValueError(f"Batch {index} must be an object.")
            batch_id = str(batch.get("id") or batch.get("batch_id") or index)
            input_text = str(batch.get("input") or "")
            expected = str(batch.get("expected_output_path") or "")
            async with semaphore:
                return await self.run_role(
                    event,
                    role=role,
                    input_text=input_text,
                    expected_output_path=expected,
                    batch_id=batch_id,
                )

        tasks = [
            asyncio.create_task(run_one(index, batch))
            for index, batch in enumerate(batches)
        ]
        results: list[dict[str, Any]] = []
        for task in asyncio.as_completed(tasks):
            result = await task
            results.append(result)
            if result.get("status") == "failed" and not continue_on_error:
                for pending in tasks:
                    if not pending.done():
                        pending.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise RuntimeError(
                    f"SubAgent batch failed: {result.get('batch_id')} "
                    f"{result.get('error')}"
                )

        results.sort(key=lambda item: str(item.get("batch_id") or ""))
        failed = [item for item in results if item.get("status") == "failed"]
        missing = [item for item in results if item.get("status") == "missing_output"]
        status = "failed" if failed else "missing_output" if missing else "ok"
        return {
            "role": role,
            "status": status,
            "max_concurrency": max_concurrency,
            "continue_on_error": bool(continue_on_error),
            "results": results,
        }

    async def _handoff_for_role(
        self,
        role: str,
    ) -> HandoffTool[AstrAgentContext]:
        handoff_name = (
            f"transfer_to_"
            f"{UnderstandAnythingSubAgentRegistry.agent_name_for_role(role)}"
        )
        orchestrator = getattr(self.context, "subagent_orchestrator", None)
        handoffs = getattr(orchestrator, "handoffs", [])
        if not isinstance(handoffs, list):
            handoffs = []
        for handoff in handoffs:
            if str(getattr(handoff, "name", "")).strip() == handoff_name:
                return handoff
        raise RuntimeError(
            "Understand Anything SubAgent role is not registered or loaded: "
            f"{role}. Open the plugin Dashboard and run UA SubAgents registration.",
        )

    def ensure_ready(self) -> None:
        missing = self.missing_roles()
        if missing:
            raise RuntimeError(
                "Understand Anything SubAgents are not registered or loaded. "
                "Open the plugin Dashboard and run UA SubAgents registration. "
                f"Missing roles: {', '.join(missing)}",
            )

    def missing_roles(self) -> list[str]:
        orchestrator = getattr(self.context, "subagent_orchestrator", None)
        handoffs = getattr(orchestrator, "handoffs", [])
        if not isinstance(handoffs, list):
            handoffs = []
        loaded = {
            str(getattr(handoff, "name", "")).strip()
            for handoff in handoffs
            if str(getattr(handoff, "name", "")).strip()
        }
        missing: list[str] = []
        for role in ROLE_NAMES:
            name = UnderstandAnythingSubAgentRegistry.agent_name_for_role(role)
            if f"transfer_to_{name}" not in loaded:
                missing.append(role)
        return missing

    def _run_context(self, worker_event: AstrMessageEvent) -> ContextWrapper[Any]:
        if self._uses_custom_handoff_executor:
            return ContextWrapper(
                context=SimpleNamespace(context=self.context, event=worker_event),
                tool_call_timeout=300,
            )
        return ContextWrapper(
            context=AstrAgentContext(context=self.context, event=worker_event),
            tool_call_timeout=300,
        )

    @staticmethod
    async def _execute_handoff(
        handoff: HandoffTool[AstrAgentContext],
        run_context: ContextWrapper[AstrAgentContext],
        tool_args: dict[str, Any],
    ) -> str:
        chunks: list[str] = []
        async for item in FunctionToolExecutor.execute(
            handoff,
            run_context,
            **tool_args,
        ):
            if isinstance(item, mcp.types.CallToolResult):
                for content in item.content:
                    if isinstance(content, mcp.types.TextContent):
                        chunks.append(content.text)
        return "\n".join(chunk for chunk in chunks if chunk)

    @staticmethod
    def _worker_event(
        parent: AstrMessageEvent,
        role: str,
        batch_id: str | None,
    ) -> AstrMessageEvent:
        suffix = batch_id or uuid.uuid4().hex[:8]
        text = f"[Understand Anything SubAgent:{role}] {suffix}"
        message = AstrBotMessage()
        message.type = MessageType.FRIEND_MESSAGE
        message.self_id = PLUGIN_NAME
        message.session_id = f"ua-subagent:{role}:{suffix}:{uuid.uuid4().hex[:8]}"
        message.message_id = uuid.uuid4().hex
        message.sender = MessageMember(user_id="ua-subagent", nickname=role)
        message.message = [Plain(text=text)]
        message.message_str = text
        message.raw_message = {
            "source": "understand-anything-subagent",
            "parent_session_id": getattr(parent, "session_id", ""),
            "role": role,
            "batch_id": batch_id,
        }
        event = AstrMessageEvent(
            text,
            message,
            PlatformMetadata(
                name="ua-subagent",
                description="Understand Anything internal SubAgent",
                id=PLUGIN_NAME,
            ),
            message.session_id,
        )
        event.role = getattr(parent, "role", "admin")
        event.is_wake = True
        event.is_at_or_wake_command = True
        return event

    @staticmethod
    def _normalize_role(role: str) -> str:
        normalized = str(role).strip()
        if normalized not in ROLE_NAMES:
            raise ValueError(
                f"Unsupported UA SubAgent role: {role}. "
                f"Allowed roles: {', '.join(sorted(ROLE_NAMES))}",
            )
        return normalized

    @staticmethod
    def _output_state(path: str) -> dict[str, Any]:
        if not path:
            return {"path": "", "exists": False}
        resolved = Path(path).expanduser().resolve(strict=False)
        return {
            "path": str(resolved),
            "exists": resolved.exists(),
            "is_file": resolved.is_file(),
        }

    def _log(self, message: str) -> None:
        if self.log_fn is not None:
            self.log_fn(message)
