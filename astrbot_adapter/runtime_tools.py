from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class RuntimeToolStatus:
    name: str
    command: str
    path: str
    available: bool
    supported: bool
    version: str
    source: str
    min_major: int | None = None
    blocking_reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class RuntimeToolset:
    node: RuntimeToolStatus
    pnpm: RuntimeToolStatus
    git: RuntimeToolStatus

    def to_dict(self) -> dict[str, Any]:
        return {
            "node": self.node.to_dict(),
            "pnpm": self.pnpm.to_dict(),
            "git": self.git.to_dict(),
        }


def detect_runtime_tools() -> RuntimeToolset:
    return RuntimeToolset(
        node=detect_tool("node", "UA_NODE_BIN", min_major=22),
        pnpm=detect_tool("pnpm", "UA_PNPM_BIN", min_major=10),
        git=detect_tool("git", "UA_GIT_BIN"),
    )


def detect_tool(
    name: str,
    env_var: str,
    *,
    min_major: int | None = None,
) -> RuntimeToolStatus:
    override = (os.environ.get(env_var) or "").strip()
    command = override or name
    source = "env" if override else "path"
    path = _resolve_command(command)
    if not path:
        reason = (
            f"{env_var} points to an executable that was not found: {command}"
            if override
            else f"{name} was not found in PATH."
        )
        return RuntimeToolStatus(
            name=name,
            command=command,
            path="",
            available=False,
            supported=False,
            version="",
            source=source,
            min_major=min_major,
            blocking_reason=reason,
        )

    version = _read_version(path)
    major = _major_version(version)
    supported = min_major is None or (major is not None and major >= min_major)
    reason = ""
    if not supported:
        if major is None:
            reason = f"{name} version could not be detected; expected {min_major}+."
        else:
            reason = f"{name} {major} is too old; expected {min_major}+."
    return RuntimeToolStatus(
        name=name,
        command=command,
        path=path,
        available=True,
        supported=supported,
        version=version,
        source=source,
        min_major=min_major,
        blocking_reason=reason,
    )


def runtime_dependency_state(root: Path) -> dict[str, bool]:
    return {
        "node_modules": (root / "node_modules").exists(),
        "core_dist": (root / "packages" / "core" / "dist" / "index.js").is_file(),
        "runtime_dist": (root / "dist" / "index.js").is_file(),
    }


def runtime_repair_needed(root: Path) -> bool:
    state = runtime_dependency_state(root)
    return not all(state.values())


def runtime_readiness(
    root: Path,
    tools: RuntimeToolset,
    *,
    auto_repair_enabled: bool,
) -> dict[str, Any]:
    repair_needed = runtime_repair_needed(root)
    repair_available = tools.node.supported and tools.pnpm.supported
    local_reasons: list[str] = []
    repair_reasons: list[str] = []

    if not tools.node.supported:
        local_reasons.append(tools.node.blocking_reason or "Node.js 22+ is required.")
        repair_reasons.append(tools.node.blocking_reason or "Node.js 22+ is required.")
    if repair_needed:
        if not auto_repair_enabled:
            local_reasons.append(
                "Bundled Understand Anything runtime dependencies are incomplete.",
            )
        if not tools.pnpm.supported:
            reason = (
                tools.pnpm.blocking_reason
                or "pnpm 10+ is required to repair runtime dependencies."
            )
            local_reasons.append(reason)
            repair_reasons.append(reason)

    local_ready = tools.node.supported and (
        not repair_needed or (auto_repair_enabled and repair_available)
    )
    github_ready = local_ready and tools.git.available
    if not tools.git.available:
        local_git_reason = tools.git.blocking_reason or "git was not found in PATH."
    else:
        local_git_reason = ""

    return {
        "local_analysis_ready": local_ready,
        "github_analysis_ready": github_ready,
        "repair_needed": repair_needed,
        "repair_available": repair_available,
        "auto_repair_enabled": auto_repair_enabled,
        "dependency_state": runtime_dependency_state(root),
        "blocking_reasons": local_reasons,
        "repair_blocking_reasons": repair_reasons,
        "github_blocking_reason": ""
        if github_ready
        else local_git_reason or "; ".join(local_reasons),
    }


def _resolve_command(command: str) -> str:
    found = shutil.which(command)
    if found:
        return found
    candidate = Path(command).expanduser()
    if candidate.is_file():
        return str(candidate.resolve(strict=False))
    return ""


def _read_version(path: str) -> str:
    try:
        proc = subprocess.run(
            [path, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    output = (proc.stdout or proc.stderr or "").strip()
    return output.splitlines()[0].strip() if output else ""


def _major_version(version: str) -> int | None:
    match = re.search(r"(\d+)", version)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None
