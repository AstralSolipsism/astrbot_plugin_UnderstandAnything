from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

from astrbot.api import logger

from .constants import PLUGIN_ROOT, UNDERSTAND_ANYTHING_ROOT


class UnderstandAnythingRuntimeError(RuntimeError):
    """Raised when the bundled Understand Anything runtime cannot execute."""


class UnderstandAnythingRuntime:
    def __init__(
        self,
        *,
        node_bin: str = "node",
        pnpm_bin: str = "pnpm",
        auto_build: bool = True,
    ) -> None:
        self.node_bin = node_bin or "node"
        self.pnpm_bin = pnpm_bin or "pnpm"
        self.auto_build = auto_build
        self.root = UNDERSTAND_ANYTHING_ROOT
        self.bridge_script = PLUGIN_ROOT / "astrbot_adapter" / "node" / "bridge.mjs"
        self._ready = False
        self._lock = asyncio.Lock()

    async def ensure_ready(self) -> None:
        async with self._lock:
            if self._ready and self._dist_index().is_file():
                return
            if not self.root.is_dir():
                raise UnderstandAnythingRuntimeError(
                    f"Bundled Understand Anything runtime not found: {self.root}",
                )
            if not self.auto_build:
                if not self._dist_index().is_file():
                    raise UnderstandAnythingRuntimeError(
                        "Understand Anything runtime is not built and auto_build is disabled.",
                    )
                self._ready = True
                return

            if not (self.root / "node_modules").exists():
                await self._run(
                    self.pnpm_bin,
                    "install",
                    "--frozen-lockfile",
                    fallback=(self.pnpm_bin, "install"),
                )
            if not (self.root / "packages" / "core" / "dist" / "index.js").is_file():
                await self._run(
                    self.pnpm_bin,
                    "--filter",
                    "@understand-anything/core",
                    "build",
                )
            if not self._dist_index().is_file():
                await self._run(self.pnpm_bin, "build")
            self._ready = True

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
            stdout = await self._run(
                self.node_bin,
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

    async def _run(
        self,
        *command: str,
        fallback: tuple[str, ...] | None = None,
        capture: bool = False,
    ) -> str:
        proc = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(self.root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_raw, stderr_raw = await proc.communicate()
        stdout = stdout_raw.decode("utf-8", errors="replace")
        stderr = stderr_raw.decode("utf-8", errors="replace")
        if proc.returncode == 0:
            return stdout if capture else ""
        if fallback is not None:
            return await self._run(*fallback, capture=capture)
        raise UnderstandAnythingRuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(command)}\n{stderr or stdout}",
        )
