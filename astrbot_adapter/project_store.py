from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .constants import GRAPH_DIR_NAME, MAX_SOURCE_FILE_BYTES
from .path_security import PathSecurity, PathSecurityError


class ProjectStore:
    def __init__(
        self,
        project_root: Path,
        *,
        graph_root: Path | None = None,
        max_source_file_bytes: int = MAX_SOURCE_FILE_BYTES,
    ) -> None:
        self.project_root = project_root.resolve(strict=False)
        self.graph_root = (
            graph_root.resolve(strict=False)
            if graph_root is not None
            else self.project_root / GRAPH_DIR_NAME
        )
        self.max_source_file_bytes = max_source_file_bytes
        self.security = PathSecurity([self.project_root])

    def graph_path(self, file_name: str) -> Path:
        normalized = Path(file_name)
        if (
            normalized.is_absolute()
            or ".." in normalized.parts
            or len(normalized.parts) != 1
        ):
            raise PathSecurityError(f"Invalid graph file name: {file_name}")
        return self.graph_root / normalized.name

    def read_json(self, file_name: str) -> dict[str, Any]:
        path = self.graph_path(file_name)
        if not path.is_file():
            raise FileNotFoundError(f"Graph file not found: {path}")
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError(f"Graph file must contain a JSON object: {path}")
        return data

    def write_json(self, file_name: str, payload: dict[str, Any]) -> None:
        self.graph_root.mkdir(parents=True, exist_ok=True)
        path = self.graph_path(file_name)
        with path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")

    def read_optional_json(self, file_name: str) -> dict[str, Any] | None:
        try:
            return self.read_json(file_name)
        except FileNotFoundError:
            return None

    def read_source_file(self, file_path: str) -> dict[str, Any]:
        relative_path = self.security.normalize_relative_path(
            self.project_root,
            file_path,
        )

        absolute_path = self.project_root / relative_path
        if not absolute_path.is_file():
            raise FileNotFoundError(f"Source file not found: {relative_path}")
        stat = absolute_path.stat()
        if stat.st_size > self.max_source_file_bytes:
            raise ValueError("File is too large to preview.")

        raw = absolute_path.read_bytes()
        if b"\0" in raw:
            raise ValueError("Binary files cannot be previewed.")
        content = raw.decode("utf-8")
        return {
            "path": relative_path,
            "language": self._detect_language(relative_path),
            "content": content,
            "sizeBytes": len(raw),
            "lineCount": 0 if not content else len(content.splitlines()),
        }

    @staticmethod
    def _detect_language(file_path: str) -> str:
        ext = Path(file_path).suffix.lower().lstrip(".")
        return {
            "c": "c",
            "cc": "cpp",
            "cpp": "cpp",
            "cs": "csharp",
            "css": "css",
            "go": "go",
            "html": "markup",
            "java": "java",
            "js": "javascript",
            "jsx": "jsx",
            "json": "json",
            "md": "markdown",
            "mjs": "javascript",
            "py": "python",
            "rb": "ruby",
            "rs": "rust",
            "sh": "bash",
            "ts": "typescript",
            "tsx": "tsx",
            "yaml": "yaml",
            "yml": "yaml",
        }.get(ext, "text")
