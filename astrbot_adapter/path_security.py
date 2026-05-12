from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path


class PathSecurityError(ValueError):
    """Raised when a requested project or file path is outside policy."""


class PathSecurity:
    def __init__(
        self,
        allowed_roots: Iterable[str | Path] | None = None,
        *,
        implicit_roots: Iterable[str | Path] | None = None,
    ) -> None:
        roots = [Path(root).expanduser() for root in allowed_roots or [] if str(root)]
        self.allowed_roots = [root.resolve(strict=False) for root in roots]
        self.implicit_roots = [
            Path(root).expanduser().resolve(strict=False)
            for root in implicit_roots or []
            if str(root)
        ]

    def resolve_project_path(
        self,
        raw_path: str | Path | None,
        *,
        must_exist: bool = True,
    ) -> Path:
        project_path = Path(raw_path).expanduser() if raw_path else Path.cwd()
        resolved = project_path.resolve(strict=False)
        if must_exist and (not resolved.exists() or not resolved.is_dir()):
            raise PathSecurityError(f"Project path is not a directory: {resolved}")
        if not must_exist and resolved.exists() and not resolved.is_dir():
            raise PathSecurityError(f"Project path is not a directory: {resolved}")
        if not self._is_under_allowed_root(resolved):
            roots = ", ".join(str(root) for root in self.allowed_roots)
            raise PathSecurityError(
                f"Project path is outside configured allowed roots: {resolved}. "
                f"Allowed roots: {roots}",
            )
        return resolved

    def resolve_project_file(self, project_root: Path, raw_path: str | Path) -> Path:
        if not raw_path:
            raise PathSecurityError("File path is required.")
        path = Path(raw_path)
        if path.is_absolute():
            candidate = path.resolve(strict=False)
        else:
            candidate = (project_root / path).resolve(strict=False)
        self._ensure_inside(candidate, project_root, "File path")
        return candidate

    def normalize_relative_path(self, project_root: Path, raw_path: str | Path) -> str:
        candidate = self.resolve_project_file(project_root, raw_path)
        try:
            relative = candidate.relative_to(project_root.resolve(strict=False))
        except ValueError as exc:
            raise PathSecurityError("File path must stay inside project root.") from exc
        value = relative.as_posix()
        if not value or value.startswith("../") or value == "..":
            raise PathSecurityError("File path must stay inside project root.")
        return value

    def _is_under_allowed_root(self, path: Path) -> bool:
        if not self.allowed_roots:
            return True
        return any(
            self._is_relative_to(path, root)
            for root in [*self.allowed_roots, *self.implicit_roots]
        )

    @staticmethod
    def _ensure_inside(path: Path, root: Path, label: str) -> None:
        if not PathSecurity._is_relative_to(path, root.resolve(strict=False)):
            raise PathSecurityError(f"{label} must stay inside project root: {path}")

    @staticmethod
    def _is_relative_to(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False
