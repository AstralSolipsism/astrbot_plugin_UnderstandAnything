from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

from astrbot.api import logger

from .constants import PLUGIN_ROOT, UNDERSTAND_ANYTHING_ROOT
from .runtime_tools import RuntimeToolset, RuntimeToolStatus, detect_runtime_tools


class UnderstandAnythingRuntimeError(RuntimeError):
    """Raised when the bundled Understand Anything runtime cannot execute."""


class UnderstandAnythingRuntime:
    def __init__(
        self,
        *,
        auto_build: bool = True,
    ) -> None:
        self.auto_build = auto_build
        self.root = UNDERSTAND_ANYTHING_ROOT
        self.bridge_script = PLUGIN_ROOT / "astrbot_adapter" / "node" / "bridge.mjs"
        self._ready = False
        self._lock = asyncio.Lock()

    def tools(self) -> RuntimeToolset:
        return detect_runtime_tools()

    async def ensure_ready(self) -> None:
        async with self._lock:
            if self._ready and not self._repair_needed():
                return
            if not self.root.is_dir():
                raise UnderstandAnythingRuntimeError(
                    f"Bundled Understand Anything runtime not found: {self.root}",
                )
            tools = self.tools()
            self._require_tool(
                tools.node, "Node.js 22+ is required to run Understand Anything."
            )
            if not self.auto_build:
                if self._repair_needed():
                    raise UnderstandAnythingRuntimeError(
                        "Understand Anything runtime dependencies are incomplete and automatic repair is disabled.",
                    )
                self._ready = True
                return

            if self._repair_needed():
                self._require_tool(
                    tools.pnpm,
                    "pnpm 10+ is required to repair Understand Anything runtime dependencies.",
                )
                await self._repair_with_tools(tools)
            self._ready = True

    async def repair(self) -> dict[str, Any]:
        async with self._lock:
            if not self.root.is_dir():
                raise UnderstandAnythingRuntimeError(
                    f"Bundled Understand Anything runtime not found: {self.root}",
                )
            tools = self.tools()
            self._require_tool(
                tools.node, "Node.js 22+ is required to repair Understand Anything."
            )
            self._require_tool(
                tools.pnpm,
                "pnpm 10+ is required to repair Understand Anything runtime dependencies.",
            )
            actions = await self._repair_with_tools(tools)
            self._ready = not self._repair_needed()
            return {
                "actions": actions,
                "tools": tools.to_dict(),
                "ready": self._ready,
            }

    async def _repair_with_tools(self, tools: RuntimeToolset) -> list[str]:
        actions: list[str] = []
        if not (self.root / "node_modules").exists():
            await self._run(
                tools.pnpm.path,
                "install",
                "--frozen-lockfile",
            )
            actions.append("pnpm install --frozen-lockfile")
        if not (self.root / "packages" / "core" / "dist" / "index.js").is_file():
            if not (self.root / "node_modules").exists():
                raise UnderstandAnythingRuntimeError(
                    "pnpm install completed but node_modules is still missing.",
                )
            await self._run(
                tools.pnpm.path,
                "--filter",
                "@understand-anything/core",
                "build",
            )
            actions.append("pnpm --filter @understand-anything/core build")
        if not self._assistant_dist_index().is_file():
            await self._run(
                tools.pnpm.path,
                "--filter",
                "@understand-anything/assistant",
                "build",
            )
            actions.append("pnpm --filter @understand-anything/assistant build")
        if not self._dist_index().is_file():
            await self._run(tools.pnpm.path, "build")
            actions.append("pnpm build")
        return actions

    async def run_action(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        await self.ensure_ready()
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            suffix=".json",
            delete=False,
            dir=Path(tempfile.gettempdir()),
        ) as f:
            json.dump(payload, f, ensure_ascii=False)
            payload_path = Path(f.name)
        try:
            tools = self.tools()
            self._require_tool(
                tools.node, "Node.js 22+ is required to run Understand Anything."
            )
            stdout = await self._run(
                tools.node.path,
                str(self.bridge_script),
                str(self.root),
                action,
                str(payload_path),
                capture=True,
            )
            data = json.loads(stdout)
            if not isinstance(data, dict):
                raise UnderstandAnythingRuntimeError(
                    "Understand Anything bridge returned non-object JSON.",
                )
            return data
        finally:
            try:
                payload_path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning(
                    "Failed to cleanup Understand Anything payload file: %s",
                    exc,
                )

    def _dist_index(self) -> Path:
        return self.root / "dist" / "index.js"

    def _assistant_dist_index(self) -> Path:
        return self.root / "packages" / "assistant" / "dist" / "index.js"

    def _repair_needed(self) -> bool:
        return not (
            (self.root / "node_modules").exists()
            and (self.root / "packages" / "core" / "dist" / "index.js").is_file()
            and self._assistant_dist_index().is_file()
            and self._dist_index().is_file()
        )

    @staticmethod
    def _require_tool(tool: RuntimeToolStatus, message: str) -> None:
        if tool.supported:
            return
        detail = tool.blocking_reason or message
        raise UnderstandAnythingRuntimeError(detail)

    async def _run(
        self,
        *command: str,
        capture: bool = False,
    ) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(self.root),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise UnderstandAnythingRuntimeError(
                f"Failed to execute command: {' '.join(command)}\n{exc}",
            ) from exc
        stdout_raw, stderr_raw = await proc.communicate()
        stdout = stdout_raw.decode("utf-8", errors="replace")
        stderr = stderr_raw.decode("utf-8", errors="replace")
        if proc.returncode == 0:
            return stdout if capture else ""
        raise UnderstandAnythingRuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(command)}\n{stderr or stdout}",
        )
