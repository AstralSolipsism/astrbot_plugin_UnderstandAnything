from __future__ import annotations

import os
import time
from fnmatch import fnmatchcase
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
    current_exclusions = summarize_current_exclusions(project_root, content)
    return {
        "kind": "understandignore",
        "project_root": str(project_root),
        "graph_root": str(graph_root),
        "ignore_path": str(ignore_path),
        "content": content,
        "summary": summary
        | {
            "generated": generated,
            "current_exclusions": current_exclusions,
        },
        "instructions": (
            "Scan rules are generated automatically. Edit this content from the "
            "Dashboard project ignore editor when rerunning analysis needs a "
            "different scope."
        ),
        "expires_at": time.time() + timeout_seconds,
    }


def starter_ignore_content(project_root: Path) -> str:
    return _starter_content(summarize_project_for_ignore(project_root))


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


def summarize_current_exclusions(
    project_root: Path,
    ignore_content: str,
    *,
    max_directories: int = 40,
) -> dict[str, Any]:
    patterns = sorted(DEFAULT_IGNORE_PATTERNS) + _active_ignore_patterns(ignore_content)
    directories = _excluded_directories(project_root, patterns)
    visible = directories[:max_directories]
    return {
        "directories": visible,
        "directory_count": len(directories),
        "truncated": max(0, len(directories) - len(visible)),
    }


def write_ignore_content(graph_root: Path, content: str) -> str:
    graph_root.mkdir(parents=True, exist_ok=True)
    ignore_path = graph_root / ".understandignore"
    normalized = content.replace("\r\n", "\n").strip()
    ignore_path.write_text(normalized + ("\n" if normalized else ""), encoding="utf-8")
    return ignore_path.read_text(encoding="utf-8")


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
        "# Syntax follows .gitignore. Suggested rules are commented out by default.",
        "# Uncomment a suggestion to activate it.",
        "# Use !pattern to force-include something excluded by defaults.",
        "",
        "# Built-in defaults are always excluded unless negated:",
        "# node_modules/, .git/, dist/, build/, obj/, *.lock, *.min.js, etc.",
        "",
    ]
    gitignore_patterns = summary.get("gitignore_patterns", [])
    if gitignore_patterns:
        lines += ["# --- From .gitignore ---", ""]
        lines += [f"# {pattern}" for pattern in gitignore_patterns]
        lines.append("")
    detected_dirs = summary.get("detected_dirs", [])
    if detected_dirs:
        lines += ["# --- Detected optional directories ---", ""]
        lines += [f"# {dirname}/" for dirname in detected_dirs]
        lines.append("")
    lines += ["# --- Test file patterns ---", ""]
    lines += [f"# {pattern}" for pattern in TEST_FILE_PATTERNS]
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


def _active_ignore_patterns(content: str) -> list[str]:
    patterns: list[str] = []
    for raw_line in str(content or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(line)
    return patterns


def _excluded_directories(project_root: Path, patterns: list[str]) -> list[str]:
    excluded: list[str] = []
    try:
        for root, dirs, _files in os.walk(project_root):
            dirs.sort()
            root_path = Path(root)
            kept_dirs: list[str] = []
            for dirname in dirs:
                path = root_path / dirname
                rel_path = path.relative_to(project_root).as_posix()
                if _is_directory_excluded(rel_path, patterns):
                    excluded.append(rel_path)
                else:
                    kept_dirs.append(dirname)
            dirs[:] = kept_dirs
    except OSError:
        return []
    return excluded


def _is_directory_excluded(rel_path: str, patterns: list[str]) -> bool:
    excluded = False
    for pattern in patterns:
        normalized = pattern.strip()
        if not normalized:
            continue
        negated = normalized.startswith("!")
        if negated:
            normalized = normalized[1:].strip()
        if _matches_directory_pattern(rel_path, normalized):
            excluded = not negated
    return excluded


def _matches_directory_pattern(rel_path: str, pattern: str) -> bool:
    normalized = pattern.replace("\\", "/").strip()
    if not normalized or normalized.startswith("#"):
        return False
    anchored = normalized.startswith("/")
    normalized = normalized.lstrip("/").rstrip("/")
    if not normalized:
        return False
    rel = rel_path.strip("/")
    if "/" not in normalized:
        return any(
            fnmatchcase(segment, normalized) for segment in rel.split("/") if segment
        )
    if fnmatchcase(rel, normalized) or rel.startswith(f"{normalized}/"):
        return True
    if normalized.endswith("/**"):
        base = normalized[:-3].rstrip("/")
        return rel == base or rel.startswith(f"{base}/")
    if anchored:
        return False
    return fnmatchcase(rel, f"*/{normalized}") or fnmatchcase(
        rel,
        f"*/{normalized}/*",
    )


def _normalize_pattern(pattern: str) -> str:
    return pattern.strip().rstrip("/")
