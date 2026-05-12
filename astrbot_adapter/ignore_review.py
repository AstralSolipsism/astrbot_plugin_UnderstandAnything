from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

DEFAULT_IGNORE_PATTERNS = {
    "node_modules",
    "node_modules/",
    ".git",
    ".git/",
    "vendor",
    "vendor/",
    "venv",
    "venv/",
    ".venv",
    ".venv/",
    "__pycache__",
    "__pycache__/",
    "dist",
    "dist/",
    "build",
    "build/",
    "out",
    "out/",
    "coverage",
    "coverage/",
    ".next",
    ".next/",
    ".cache",
    ".cache/",
    ".turbo",
    ".turbo/",
    "target",
    "target/",
    "obj",
    "obj/",
    "*.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.generated.*",
    ".idea",
    ".idea/",
    ".vscode",
    ".vscode/",
    "LICENSE",
    ".gitignore",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc*",
    "*.log",
}

DETECTED_DIRECTORY_CANDIDATES = (
    "__tests__",
    "test",
    "tests",
    "fixtures",
    "testdata",
    "docs",
    "examples",
    "scripts",
    "migrations",
    ".storybook",
)

TEST_FILE_PATTERNS = ("*.test.*", "*.spec.*", "*.snap")
CONTINUE_WORDS = {"继续", "确认", "开始", "运行", "ok", "yes", "y", "continue", "go"}
CANCEL_WORDS = {"取消", "停止", "cancel", "stop", "no", "n"}


def build_ignore_confirmation(
    project_root: Path,
    graph_root: Path,
    *,
    timeout_seconds: int = 600,
) -> dict[str, Any]:
    graph_root.mkdir(parents=True, exist_ok=True)
    ignore_path = graph_root / ".understandignore"
    generated = not ignore_path.exists()
    summary = summarize_project_for_ignore(project_root)
    if generated:
        ignore_path.write_text(_starter_content(summary), encoding="utf-8")
    content = ignore_path.read_text(encoding="utf-8")
    return {
        "kind": "understandignore",
        "project_root": str(project_root),
        "graph_root": str(graph_root),
        "ignore_path": str(ignore_path),
        "content": content,
        "summary": summary | {"generated": generated},
        "instructions": (
            "Reply with continue/ok to proceed, cancel to stop, "
            "exclude <patterns> to add exclusions, or include <patterns> to force include."
        ),
        "expires_at": time.time() + timeout_seconds,
    }


def summarize_project_for_ignore(project_root: Path) -> dict[str, Any]:
    gitignore_patterns = _gitignore_suggestions(project_root)
    detected_dirs = [
        dirname
        for dirname in DETECTED_DIRECTORY_CANDIDATES
        if (project_root / dirname).exists()
    ]
    test_files = _has_test_files(project_root)
    return {
        "gitignore_patterns": gitignore_patterns,
        "detected_dirs": detected_dirs,
        "test_file_patterns": list(TEST_FILE_PATTERNS) if test_files else [],
    }


def write_ignore_content(graph_root: Path, content: str) -> str:
    graph_root.mkdir(parents=True, exist_ok=True)
    ignore_path = graph_root / ".understandignore"
    normalized = content.replace("\r\n", "\n").strip()
    ignore_path.write_text(normalized + ("\n" if normalized else ""), encoding="utf-8")
    return ignore_path.read_text(encoding="utf-8")


def apply_confirmation_reply(graph_root: Path, reply: str) -> tuple[str, str]:
    action, payload = parse_confirmation_reply(reply)
    if action != "update":
        return action, ""
    content = append_ignore_patterns(graph_root, payload)
    return action, content


def parse_confirmation_reply(reply: str) -> tuple[str, list[str]]:
    text = str(reply or "").strip()
    normalized = text.casefold()
    if normalized in CONTINUE_WORDS:
        return "continue", []
    if normalized in CANCEL_WORDS:
        return "cancel", []

    for prefix in ("排除", "exclude"):
        payload = _strip_prefix(text, prefix)
        if payload is not None:
            return "update", _patterns_from_text(payload, force_include=False)
    for prefix in ("包含", "保留", "include"):
        payload = _strip_prefix(text, prefix)
        if payload is not None:
            return "update", _patterns_from_text(payload, force_include=True)
    return "update", _patterns_from_text(text, force_include=False)


def append_ignore_patterns(graph_root: Path, patterns: list[str]) -> str:
    if not patterns:
        return (graph_root / ".understandignore").read_text(encoding="utf-8")
    ignore_path = graph_root / ".understandignore"
    existing = ignore_path.read_text(encoding="utf-8") if ignore_path.exists() else ""
    addition = "\n".join(patterns)
    marker = "# --- Confirmed additions ---"
    next_content = existing.rstrip()
    if marker not in next_content:
        next_content += f"\n\n{marker}\n"
    elif next_content:
        next_content += "\n"
    next_content += addition
    return write_ignore_content(graph_root, next_content)


def _starter_content(summary: dict[str, Any]) -> str:
    lines = [
        "# .understandignore - patterns for files/dirs to exclude from analysis",
        "# Syntax follows .gitignore. Review the generated suggestions before analysis.",
        "# Use !pattern to force-include something excluded by defaults.",
        "",
        "# Built-in defaults are always excluded unless negated:",
        "# node_modules/, .git/, dist/, build/, obj/, *.lock, *.min.js, etc.",
        "",
    ]
    gitignore_patterns = summary.get("gitignore_patterns", [])
    if gitignore_patterns:
        lines += ["# --- From .gitignore ---", ""]
        lines += [str(pattern) for pattern in gitignore_patterns]
        lines.append("")
    detected_dirs = summary.get("detected_dirs", [])
    if detected_dirs:
        lines += ["# --- Detected optional directories ---", ""]
        lines += [f"{dirname}/" for dirname in detected_dirs]
        lines.append("")
    lines += ["# --- Test file patterns ---", ""]
    lines += [f"{pattern}" for pattern in TEST_FILE_PATTERNS]
    return "\n".join(lines).rstrip() + "\n"


def _gitignore_suggestions(project_root: Path) -> list[str]:
    gitignore_path = project_root / ".gitignore"
    if not gitignore_path.is_file():
        return []
    suggestions: list[str] = []
    default_patterns = {_normalize_pattern(item) for item in DEFAULT_IGNORE_PATTERNS}
    for raw_line in gitignore_path.read_text(
        encoding="utf-8", errors="replace"
    ).splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if _normalize_pattern(line) in default_patterns:
            continue
        suggestions.append(line)
    return suggestions


def _has_test_files(project_root: Path) -> bool:
    ignored_dirs = {
        _normalize_pattern(pattern)
        for pattern in DEFAULT_IGNORE_PATTERNS
        if "*" not in pattern and "." not in pattern.lstrip(".")
    } | {".git", "node_modules", "dist", "build", "target", "obj", ".venv", "venv"}
    try:
        for _root, dirs, files in os.walk(project_root):
            dirs[:] = [dirname for dirname in dirs if dirname not in ignored_dirs]
            for name in files:
                if ".test." in name or ".spec." in name or name.endswith(".snap"):
                    return True
    except OSError:
        return False
    return False


def _strip_prefix(text: str, prefix: str) -> str | None:
    pattern = rf"^\s*{re.escape(prefix)}(?:\s+|:|：)(.*)$"
    match = re.match(pattern, text, flags=re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else None


def _patterns_from_text(text: str, *, force_include: bool) -> list[str]:
    cleaned = text.replace("```", "").replace("，", "\n").replace(",", "\n")
    parts: list[str] = []
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if " " in stripped and not any(
            char in stripped for char in ("/", "\\", "*", "!")
        ):
            parts.extend(item.strip() for item in stripped.split() if item.strip())
        else:
            parts.append(stripped)
    if force_include:
        return [
            pattern if pattern.startswith("!") else f"!{pattern}" for pattern in parts
        ]
    return parts


def _normalize_pattern(pattern: str) -> str:
    return pattern.strip().rstrip("/")
