from __future__ import annotations

import json
import contextlib
import fnmatch
import hashlib
import os
import shlex
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from .constants import (
    AGENT_PROMPTS_ROOT,
    PLUGIN_ROOT,
    PLUGIN_SKILLS_ROOT,
    UNDERSTAND_ANYTHING_ROOT,
)

SANDBOX_WORKSPACE_ROOT = "ua-workspaces"
SANDBOX_BUNDLE_ROOT = "ua-bundles/current"
SANDBOX_BUNDLE_MANIFEST_FILE = ".ua-bundle-manifest.json"
SANDBOX_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".understand-anything",
        ".gitnexus",
        ".claude",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
        "node_modules",
        "dist",
        "build",
        ".venv",
        "venv",
    }
)
SANDBOX_BUNDLE_EXCLUDED_DIRS = SANDBOX_EXCLUDED_DIRS - frozenset(
    {"node_modules", "dist", "build"}
)
SANDBOX_PROJECT_HARD_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".understand-anything",
        ".gitnexus",
        ".claude",
        ".pytest_cache",
        ".ruff_cache",
    }
)
SANDBOX_EXCLUDED_FILES = frozenset({"AGENTS.md", "CLAUDE.md"})
SANDBOX_DEFAULT_IGNORE_PATTERNS = (
    "node_modules/",
    ".git/",
    "vendor/",
    "venv/",
    ".venv/",
    "__pycache__/",
    "dist/",
    "build/",
    "out/",
    "coverage/",
    ".next/",
    ".cache/",
    ".turbo/",
    "target/",
    "obj/",
    "*.lock",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.svg",
    "*.ico",
    "*.woff",
    "*.woff2",
    "*.ttf",
    "*.eot",
    "*.mp3",
    "*.mp4",
    "*.pdf",
    "*.zip",
    "*.tar",
    "*.gz",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.generated.*",
    ".idea/",
    ".vscode/",
    "LICENSE",
    ".gitignore",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc*",
    "*.log",
)


@dataclass(frozen=True)
class _SandboxIgnoreRule:
    pattern: str
    negated: bool
    directory_only: bool
    anchored: bool
    has_slash: bool

    @classmethod
    def parse(cls, raw: str) -> "_SandboxIgnoreRule | None":
        text = raw.strip()
        if not text or text.startswith("#"):
            return None
        negated = text.startswith("!")
        if negated:
            text = text[1:].strip()
        if not text:
            return None
        anchored = text.startswith("/")
        text = text.lstrip("/")
        directory_only = text.endswith("/")
        text = text.rstrip("/")
        if not text:
            return None
        return cls(
            pattern=text,
            negated=negated,
            directory_only=directory_only,
            anchored=anchored,
            has_slash="/" in text,
        )

    def matches(self, relative_path: str) -> bool:
        path = relative_path.strip("/")
        if not path:
            return False
        if self.directory_only:
            return self._matches_directory(path)
        if self.anchored or self.has_slash:
            return fnmatch.fnmatchcase(path, self.pattern)
        return any(
            fnmatch.fnmatchcase(segment, self.pattern)
            for segment in path.split("/")
        )

    def _matches_directory(self, path: str) -> bool:
        if self.anchored or self.has_slash:
            return path == self.pattern or path.startswith(f"{self.pattern}/")
        return self.pattern in path.split("/")[:-1]


class _SandboxIgnoreMatcher:
    def __init__(self, rules: list[_SandboxIgnoreRule]) -> None:
        self.rules = rules

    @classmethod
    def for_project(cls, project_root: Path, graph_root: Path | None) -> "_SandboxIgnoreMatcher":
        rules: list[_SandboxIgnoreRule] = []
        cls._add_patterns(rules, SANDBOX_DEFAULT_IGNORE_PATTERNS)
        ignore_paths = []
        if graph_root is not None:
            ignore_paths.append(graph_root / ".understandignore")
        legacy_graph_ignore = project_root / ".understand-anything" / ".understandignore"
        if not ignore_paths or legacy_graph_ignore.resolve(strict=False) != ignore_paths[0].resolve(strict=False):
            ignore_paths.append(legacy_graph_ignore)
        ignore_paths.append(project_root / ".understandignore")
        for ignore_path in ignore_paths:
            if not ignore_path.is_file():
                continue
            try:
                content = ignore_path.read_text(encoding="utf-8")
            except OSError:
                continue
            cls._add_patterns(rules, content.splitlines())
        return cls(rules)

    @staticmethod
    def _add_patterns(rules: list[_SandboxIgnoreRule], patterns: Any) -> None:
        for pattern in patterns:
            rule = _SandboxIgnoreRule.parse(str(pattern))
            if rule is not None:
                rules.append(rule)

    def ignores(self, relative_path: str) -> bool:
        normalized = relative_path.replace("\\", "/").strip("/")
        ignored = False
        for rule in self.rules:
            if rule.matches(normalized):
                ignored = not rule.negated
        return ignored


class ExecutionWorkspaceTransport(Protocol):
    async def upload_file(self, local_path: str, remote_path: str) -> None: ...

    async def download_file(self, remote_path: str, local_path: str) -> None: ...

    async def shell_exec(self, command: str) -> dict[str, Any]: ...


class AstrBotSandboxTransport:
    def __init__(self, booter: Any) -> None:
        self.booter = booter

    @classmethod
    async def create(cls, context: Any, session_id: str) -> "AstrBotSandboxTransport":
        from astrbot.core.computer.computer_client import get_booter

        return cls(await get_booter(context, session_id))

    async def upload_file(self, local_path: str, remote_path: str) -> None:
        result = await self.booter.upload_file(local_path, remote_path)
        if not isinstance(result, dict) or not result.get("success"):
            detail = ""
            if isinstance(result, dict):
                detail = str(result.get("message") or result.get("error") or "")
            raise RuntimeError(
                f"Sandbox upload failed for {remote_path}: {detail or result}"
            )

    async def download_file(self, remote_path: str, local_path: str) -> None:
        await self.booter.download_file(remote_path, local_path)

    async def shell_exec(self, command: str) -> dict[str, Any]:
        result = await self.booter.shell.exec(command)
        return result if isinstance(result, dict) else {"result": result}


@dataclass(frozen=True)
class ExecutionWorkspace:
    runtime_kind: str
    host_project_root: Path
    host_graph_root: Path
    runtime_project_root: str
    runtime_graph_root: str
    runtime_plugin_root: str
    runtime_skills_root: str
    runtime_agent_prompts_root: str
    cleanup_policy: str = "job-scoped"
    path_mapper: dict[str, str] | None = None
    sync_manifest: dict[str, Any] | None = None

    @property
    def is_sandbox(self) -> bool:
        return self.runtime_kind == "sandbox"

    def to_payload(self) -> dict[str, Any]:
        return {
            "runtime_kind": self.runtime_kind,
            "host_project_root": str(self.host_project_root),
            "host_graph_root": str(self.host_graph_root),
            "runtime_project_root": self.runtime_project_root,
            "runtime_graph_root": self.runtime_graph_root,
            "runtime_plugin_root": self.runtime_plugin_root,
            "runtime_skills_root": self.runtime_skills_root,
            "runtime_agent_prompts_root": self.runtime_agent_prompts_root,
            "cleanup_policy": self.cleanup_policy,
            "path_mapper": self._path_mapper_payload(),
            "sync_manifest": self._sync_manifest_payload(),
        }

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ExecutionWorkspace":
        return cls(
            runtime_kind=str(payload.get("runtime_kind") or "local"),
            host_project_root=Path(str(payload.get("host_project_root") or ".")),
            host_graph_root=Path(str(payload.get("host_graph_root") or ".")),
            runtime_project_root=str(payload.get("runtime_project_root") or ""),
            runtime_graph_root=str(payload.get("runtime_graph_root") or ""),
            runtime_plugin_root=str(payload.get("runtime_plugin_root") or ""),
            runtime_skills_root=str(payload.get("runtime_skills_root") or ""),
            runtime_agent_prompts_root=str(
                payload.get("runtime_agent_prompts_root") or "",
            ),
            cleanup_policy=str(payload.get("cleanup_policy") or "job-scoped"),
            path_mapper=(
                dict(payload["path_mapper"])
                if isinstance(payload.get("path_mapper"), dict)
                else None
            ),
            sync_manifest=(
                dict(payload["sync_manifest"])
                if isinstance(payload.get("sync_manifest"), dict)
                else None
            ),
        )

    def runtime_raw_args(self, raw_args: str) -> str:
        text = str(raw_args or "")
        for source, target in self._path_mapper_payload().items():
            if source:
                text = text.replace(source, target)
        return text

    def _path_mapper_payload(self) -> dict[str, str]:
        if self.path_mapper:
            return dict(self.path_mapper)
        return {
            str(self.host_project_root): self.runtime_project_root,
            str(self.host_graph_root): self.runtime_graph_root,
        }

    def _sync_manifest_payload(self) -> dict[str, Any]:
        if self.sync_manifest:
            return dict(self.sync_manifest)
        return {
            "version": "1.0.0",
            "runtime": self.runtime_kind,
            "project": {
                "host_root": str(self.host_project_root),
                "runtime_root": self.runtime_project_root,
                "excluded_dirs": sorted(SANDBOX_EXCLUDED_DIRS),
                "excluded_files": sorted(SANDBOX_EXCLUDED_FILES),
            },
            "bundle": {
                "remote_root": self.runtime_plugin_root,
                "manifest_file": SANDBOX_BUNDLE_MANIFEST_FILE,
            },
            "graph": {
                "host_root": str(self.host_graph_root),
                "runtime_root": self.runtime_graph_root,
            },
        }

    def runtime_agent_index(self, host_agent_files: list[Path]) -> str:
        if not self.is_sandbox:
            return "\n".join(f"- {path.name}: {path}" for path in host_agent_files)
        return "\n".join(
            f"- {path.name}: {self.runtime_agent_prompts_root}/{path.name}"
            for path in host_agent_files
        )

    async def prepare(
        self,
        transport: Any | None = None,
        *,
        bundle_sources: Any = None,
    ) -> None:
        if not self.is_sandbox:
            self.host_graph_root.mkdir(parents=True, exist_ok=True)
            return
        if transport is None:
            raise RuntimeError("Sandbox workspace transport is unavailable.")
        selected_bundle_sources = bundle_sources or self._default_bundle_sources()
        bundle_manifest = self.bundle_manifest(selected_bundle_sources)
        reuse_bundle = await self._remote_bundle_matches(transport, bundle_manifest)
        with tempfile.TemporaryDirectory(prefix="ua-sandbox-stage-") as temp_name:
            temp_root = Path(temp_name)
            project_zip = temp_root / "project.zip"
            bundle_zip = temp_root / "bundle.zip"
            self._write_zip_from_sources(
                project_zip,
                [(self.host_project_root, "")],
                source_kind="project",
                ignore_graph_root=self.host_graph_root,
            )
            project_remote_zip = f"{self.runtime_project_root}.zip"
            bundle_remote_zip = f"{self.runtime_plugin_root}.zip"
            if hasattr(transport, "shell_exec"):
                upload_targets = [project_remote_zip]
                if not reuse_bundle:
                    upload_targets.append(bundle_remote_zip)
                await self._ensure_remote_parent_dirs(transport, upload_targets)
            await transport.upload_file(str(project_zip), project_remote_zip)
            if not reuse_bundle:
                self._write_zip_from_sources(
                    bundle_zip,
                    selected_bundle_sources,
                    source_kind="bundle",
                    extra_json={SANDBOX_BUNDLE_MANIFEST_FILE: bundle_manifest},
                )
                await transport.upload_file(str(bundle_zip), bundle_remote_zip)
            if hasattr(transport, "shell_exec"):
                if reuse_bundle:
                    command = (
                        f"rm -rf {shlex.quote(self.runtime_project_root)} && "
                        "mkdir -p "
                        f"{shlex.quote(self.runtime_project_root)} "
                        f"{shlex.quote(self.runtime_graph_root)} && "
                        + self._python_unzip_command(
                            [(project_remote_zip, self.runtime_project_root)]
                        )
                    )
                else:
                    command = (
                        "rm -rf "
                        f"{shlex.quote(self.runtime_project_root)} "
                        f"{shlex.quote(self.runtime_plugin_root)} && "
                        "mkdir -p "
                        f"{shlex.quote(self.runtime_project_root)} "
                        f"{shlex.quote(self.runtime_graph_root)} "
                        f"{shlex.quote(self.runtime_plugin_root)} && "
                        + self._python_unzip_command(
                            [
                                (project_remote_zip, self.runtime_project_root),
                                (bundle_remote_zip, self.runtime_plugin_root),
                            ]
                        )
                    )
                await transport.shell_exec(command)
            graph_ignore = self.host_graph_root / ".understandignore"
            if graph_ignore.is_file():
                await transport.upload_file(
                    str(graph_ignore),
                    f"{self.runtime_graph_root}/.understandignore",
                )

    async def finalize(
        self,
        transport: ExecutionWorkspaceTransport,
        *,
        required_files: Any,
        optional_files: Any = (),
    ) -> None:
        if not self.is_sandbox:
            return
        required = self._unique_relative_files(required_files)
        optional = [
            item
            for item in self._unique_relative_files(optional_files)
            if item not in required
        ]
        if not required:
            return
        parent = self.host_graph_root.parent
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=f".{self.host_graph_root.name}.sync-",
            dir=str(parent),
        ) as staging_name:
            staging_root = Path(staging_name)
            downloaded: list[Path] = []
            missing: list[str] = []
            stale_optional: list[Path] = []
            for relative in [*required, *optional]:
                target = staging_root / relative
                remote_path = str(
                    PurePosixPath(self.runtime_graph_root) / relative.as_posix()
                )
                try:
                    await transport.download_file(remote_path, str(target))
                except Exception:
                    if relative in required:
                        missing.append(relative.as_posix())
                    else:
                        stale_optional.append(relative)
                    continue
                downloaded.append(relative)
            if missing:
                raise RuntimeError(
                    "Sandbox graph artifact sync failed; missing required file(s): "
                    + ", ".join(missing)
                )
            self._validate_downloaded_graph_json(staging_root, required)
            self._commit_staged_files(
                staging_root,
                downloaded,
                remove_files=stale_optional,
            )

    async def cleanup(self, transport: Any | None = None) -> None:
        if not self.is_sandbox or self.cleanup_policy == "none":
            return
        if transport is None or not hasattr(transport, "shell_exec"):
            return
        runtime_root = str(PurePosixPath(self.runtime_project_root).parent)
        await transport.shell_exec(f"rm -rf {shlex.quote(runtime_root)}")

    @staticmethod
    def _unique_relative_files(values: Any) -> list[Path]:
        result: list[Path] = []
        seen: set[str] = set()
        for value in values or ():
            relative = Path(str(value).replace("\\", "/"))
            if relative.is_absolute() or ".." in relative.parts or not str(value):
                raise RuntimeError(f"Invalid graph artifact path: {value}")
            normalized = relative.as_posix()
            if normalized in seen:
                continue
            seen.add(normalized)
            result.append(relative)
        return result

    @staticmethod
    def _validate_downloaded_graph_json(
        staging_root: Path,
        required: list[Path],
    ) -> None:
        for relative in required:
            path = staging_root / relative
            if not path.is_file():
                raise RuntimeError(f"Missing required graph artifact: {relative}")
            if path.suffix.lower() != ".json":
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid graph JSON artifact: {relative}") from exc
            if not isinstance(payload, dict):
                raise RuntimeError(
                    f"Graph JSON artifact must contain an object: {relative}"
                )

    def _commit_staged_files(
        self,
        staging_root: Path,
        files: list[Path],
        *,
        remove_files: list[Path] | None = None,
    ) -> None:
        self.host_graph_root.mkdir(parents=True, exist_ok=True)
        backup_root = Path(
            tempfile.mkdtemp(
                prefix=f".{self.host_graph_root.name}.backup-",
                dir=str(self.host_graph_root.parent),
            )
        )
        replaced: list[Path] = []
        try:
            for relative in files:
                source = staging_root / relative
                if not source.is_file():
                    continue
                target = self.host_graph_root / relative
                backup = backup_root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(target, backup)
                replaced.append(relative)
                os.replace(source, target)
            for relative in remove_files or []:
                target = self.host_graph_root / relative
                if not target.exists():
                    continue
                backup = backup_root / relative
                backup.parent.mkdir(parents=True, exist_ok=True)
                os.replace(target, backup)
                replaced.append(relative)
        except Exception:
            for relative in reversed(replaced):
                target = self.host_graph_root / relative
                backup = backup_root / relative
                with contextlib.suppress(FileNotFoundError):
                    if target.exists():
                        target.unlink()
                if backup.exists():
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(backup, target)
            raise
        finally:
            shutil.rmtree(backup_root, ignore_errors=True)

    @staticmethod
    def _default_bundle_sources() -> list[tuple[Path, str]]:
        candidates = [
            (PLUGIN_SKILLS_ROOT, "skills"),
            (AGENT_PROMPTS_ROOT, "astrbot_adapter/prompts/agents"),
            (PLUGIN_ROOT / "astrbot_adapter" / "node", "astrbot_adapter/node"),
            (UNDERSTAND_ANYTHING_ROOT / "dist", "understand-anything/dist"),
            (
                UNDERSTAND_ANYTHING_ROOT / "packages" / "core" / "dist",
                "understand-anything/node_modules/@understand-anything/core/dist",
            ),
            (
                UNDERSTAND_ANYTHING_ROOT / "packages" / "core" / "package.json",
                "understand-anything/node_modules/@understand-anything/core",
            ),
            (
                UNDERSTAND_ANYTHING_ROOT / "packages" / "assistant" / "dist",
                "understand-anything/node_modules/@understand-anything/assistant/dist",
            ),
            (
                UNDERSTAND_ANYTHING_ROOT / "packages" / "assistant" / "package.json",
                "understand-anything/node_modules/@understand-anything/assistant",
            ),
            *ExecutionWorkspace._runtime_node_module_sources(),
            (UNDERSTAND_ANYTHING_ROOT / "src", "understand-anything/src"),
            (UNDERSTAND_ANYTHING_ROOT / "package.json", "understand-anything"),
            (UNDERSTAND_ANYTHING_ROOT / "pnpm-lock.yaml", "understand-anything"),
        ]
        return [(source, prefix) for source, prefix in candidates if source.exists()]

    @staticmethod
    def _runtime_node_module_sources() -> list[tuple[Path, str]]:
        search_roots = (
            UNDERSTAND_ANYTHING_ROOT / "node_modules",
            UNDERSTAND_ANYTHING_ROOT / "packages" / "core" / "node_modules",
            UNDERSTAND_ANYTHING_ROOT / "packages" / "assistant" / "node_modules",
        )
        result: list[tuple[Path, str]] = []
        result_paths: set[str] = set()
        dynamic_roots = list(search_roots)
        queued = list(ExecutionWorkspace._runtime_node_module_seed_names())
        seen_names: set[str] = set()
        while queued:
            name = queued.pop(0)
            if name in seen_names:
                continue
            seen_names.add(name)
            source = ExecutionWorkspace._resolve_node_module_source(
                name,
                dynamic_roots,
            )
            if source is None:
                continue
            resolved = source.resolve(strict=False)
            resolved_key = str(resolved).casefold()
            if resolved_key not in result_paths:
                result_paths.add(resolved_key)
                result.append(
                    (
                        resolved,
                        f"understand-anything/node_modules/{name}",
                    )
                )

            # pnpm stores a package together with its private dependency graph
            # under a virtual node_modules directory. Adding that parent lets us
            # resolve transitive runtime packages without depending on hoisting.
            parent = resolved.parent
            if not any(parent == existing for existing in dynamic_roots):
                dynamic_roots.append(parent)

            package_json = resolved / "package.json"
            if not package_json.is_file():
                continue
            try:
                metadata = json.loads(package_json.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            dependencies = metadata.get("dependencies")
            if not isinstance(dependencies, dict):
                continue
            for dependency in dependencies:
                dependency_name = str(dependency).strip()
                if (
                    not dependency_name
                    or dependency_name.startswith("@understand-anything/")
                    or dependency_name in seen_names
                ):
                    continue
                queued.append(dependency_name)
        return result

    @staticmethod
    def _runtime_node_module_seed_names() -> list[str]:
        names: set[str] = set()
        for package_json in (
            UNDERSTAND_ANYTHING_ROOT / "package.json",
            UNDERSTAND_ANYTHING_ROOT / "packages" / "core" / "package.json",
            UNDERSTAND_ANYTHING_ROOT / "packages" / "assistant" / "package.json",
        ):
            if not package_json.is_file():
                continue
            try:
                metadata = json.loads(package_json.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            dependencies = metadata.get("dependencies")
            if not isinstance(dependencies, dict):
                continue
            for name in dependencies:
                package_name = str(name).strip()
                if package_name and not package_name.startswith(
                    "@understand-anything/"
                ):
                    names.add(package_name)
        return sorted(names)

    @staticmethod
    def _resolve_node_module_source(
        name: str,
        search_roots: list[Path],
    ) -> Path | None:
        relative = Path(*name.split("/"))
        for root in search_roots:
            source = root / relative
            if source.exists():
                return source
        return None

    def bundle_manifest(self, sources: Any = None) -> dict[str, Any]:
        entries = []
        for source, arcname in self._iter_source_files(
            sources or self._default_bundle_sources(),
            source_kind="bundle",
        ):
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            entries.append(
                {
                    "path": arcname,
                    "size": source.stat().st_size,
                    "sha256": digest,
                }
            )
        entries.sort(key=lambda item: item["path"])
        hasher = hashlib.sha256()
        for entry in entries:
            hasher.update(
                json.dumps(entry, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            )
            hasher.update(b"\n")
        return {
            "version": "1.0.0",
            "kind": "ua-sandbox-bundle",
            "hash": hasher.hexdigest(),
            "remote_root": self.runtime_plugin_root,
            "files": entries,
        }

    async def _remote_bundle_matches(
        self,
        transport: Any,
        manifest: dict[str, Any],
    ) -> bool:
        if not hasattr(transport, "shell_exec"):
            return False
        manifest_path = str(
            PurePosixPath(self.runtime_plugin_root) / SANDBOX_BUNDLE_MANIFEST_FILE
        )
        result = await transport.shell_exec(
            "if [ -f "
            f"{shlex.quote(manifest_path)}"
            " ]; then cat "
            f"{shlex.quote(manifest_path)}"
            "; fi"
        )
        if not self._shell_succeeded(result):
            return False
        stdout = str(result.get("stdout") or "").strip()
        if not stdout:
            return False
        try:
            remote = json.loads(stdout)
        except json.JSONDecodeError:
            return False
        if not isinstance(remote, dict):
            return False
        return (
            remote.get("kind") == manifest.get("kind")
            and remote.get("version") == manifest.get("version")
            and remote.get("hash") == manifest.get("hash")
        )

    async def _ensure_remote_parent_dirs(
        self,
        transport: Any,
        remote_paths: list[str],
    ) -> None:
        dirs: list[str] = []
        seen: set[str] = set()
        for remote_path in remote_paths:
            parent = str(PurePosixPath(remote_path).parent)
            if parent in {"", "."} or parent in seen:
                continue
            seen.add(parent)
            dirs.append(parent)
        if not dirs:
            return
        command = "mkdir -p " + " ".join(shlex.quote(path) for path in dirs)
        result = await transport.shell_exec(command)
        if not self._shell_succeeded(result):
            detail = str(result.get("stderr") or result.get("stdout") or result)
            raise RuntimeError(
                "Sandbox remote upload directory preparation failed: "
                + detail.strip()
            )

    @staticmethod
    def _shell_succeeded(result: dict[str, Any]) -> bool:
        if result.get("success") is True:
            return True
        if result.get("success") is False:
            return False
        for key in ("returncode", "return_code", "exit_code", "code"):
            if key in result:
                try:
                    return int(result[key]) == 0
                except (TypeError, ValueError):
                    return False
        return not str(result.get("stderr") or "").strip()

    @staticmethod
    def _python_unzip_command(archives: list[tuple[str, str]]) -> str:
        archive_payload = json.dumps(archives, ensure_ascii=False)
        return (
            "if command -v python3 >/dev/null 2>&1; then PYBIN=python3; "
            "elif command -v python >/dev/null 2>&1; then PYBIN=python; "
            "else echo 'python is required to unpack UA sandbox archives' >&2; "
            "exit 127; fi\n"
            "$PYBIN - <<'PY'\n"
            "import pathlib\n"
            "import zipfile\n"
            f"archives = {archive_payload}\n"
            "for zip_path, target_dir in archives:\n"
            "    target = pathlib.Path(target_dir)\n"
            "    target.mkdir(parents=True, exist_ok=True)\n"
            "    with zipfile.ZipFile(zip_path) as zf:\n"
            "        zf.extractall(target)\n"
            "PY"
        )

    @classmethod
    def _write_zip_from_sources(
        cls,
        zip_path: Path,
        sources: Any,
        *,
        source_kind: str = "project",
        extra_json: dict[str, Any] | None = None,
        ignore_graph_root: Path | None = None,
    ) -> None:
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for source, arcname in cls._iter_source_files(
                sources,
                source_kind=source_kind,
                ignore_graph_root=ignore_graph_root,
            ):
                zf.write(source, arcname)
            for arcname, payload in sorted((extra_json or {}).items()):
                zf.writestr(
                    arcname,
                    json.dumps(payload, ensure_ascii=False, sort_keys=True),
                )

    @classmethod
    def _iter_source_files(
        cls,
        sources: Any,
        *,
        source_kind: str = "project",
        ignore_graph_root: Path | None = None,
    ) -> list[tuple[Path, str]]:
        entries: list[tuple[Path, str]] = []
        for source_value, prefix_value in sources:
            source = Path(source_value)
            prefix = str(prefix_value or "").replace("\\", "/").strip("/")
            ignore_matcher = (
                _SandboxIgnoreMatcher.for_project(source, ignore_graph_root)
                if source_kind == "project" and source.is_dir()
                else None
            )
            if source.is_dir():
                for path in source.rglob("*"):
                    if cls._should_skip_path(
                        path,
                        source,
                        source_kind=source_kind,
                        ignore_matcher=ignore_matcher,
                    ):
                        continue
                    if not path.is_file():
                        continue
                    relative = path.relative_to(source).as_posix()
                    arcname = f"{prefix}/{relative}" if prefix else relative
                    entries.append((path, arcname))
            elif source.is_file():
                if cls._should_skip_file(source.name):
                    continue
                arcname = f"{prefix}/{source.name}" if prefix else source.name
                entries.append((source, arcname))
        return sorted(entries, key=lambda item: item[1])

    @classmethod
    def _should_skip_path(
        cls,
        path: Path,
        root: Path,
        *,
        source_kind: str = "project",
        ignore_matcher: _SandboxIgnoreMatcher | None = None,
    ) -> bool:
        try:
            parts = path.relative_to(root).parts
        except ValueError:
            return True
        excluded_dirs = (
            SANDBOX_BUNDLE_EXCLUDED_DIRS
            if source_kind == "bundle"
            else SANDBOX_PROJECT_HARD_EXCLUDED_DIRS
        )
        if any(part in excluded_dirs for part in parts[:-1]):
            return True
        if cls._should_skip_file(path.name):
            return True
        if source_kind == "project" and ignore_matcher is not None:
            return ignore_matcher.ignores(PurePosixPath(*parts).as_posix())
        return False

    @staticmethod
    def _should_skip_file(name: str) -> bool:
        return name in SANDBOX_EXCLUDED_FILES


def execution_workspace_from_job(
    *,
    job_id: str,
    runtime_kind: str,
    host_project_root: Path,
    host_graph_root: Path,
) -> ExecutionWorkspace:
    normalized_runtime = "sandbox" if runtime_kind == "sandbox" else "local"
    if normalized_runtime == "sandbox":
        runtime_root = f"{SANDBOX_WORKSPACE_ROOT}/{job_id}"
        return ExecutionWorkspace(
            runtime_kind="sandbox",
            host_project_root=host_project_root,
            host_graph_root=host_graph_root,
            runtime_project_root=f"{runtime_root}/project",
            runtime_graph_root=f"{runtime_root}/graph",
            runtime_plugin_root=SANDBOX_BUNDLE_ROOT,
            runtime_skills_root=f"{SANDBOX_BUNDLE_ROOT}/skills",
            runtime_agent_prompts_root=(
                f"{SANDBOX_BUNDLE_ROOT}/astrbot_adapter/prompts/agents"
            ),
        )
    return ExecutionWorkspace(
        runtime_kind="local",
        host_project_root=host_project_root,
        host_graph_root=host_graph_root,
        runtime_project_root=str(host_project_root),
        runtime_graph_root=str(host_graph_root),
        runtime_plugin_root=str(PLUGIN_ROOT),
        runtime_skills_root=str(PLUGIN_SKILLS_ROOT),
        runtime_agent_prompts_root=str(AGENT_PROMPTS_ROOT),
        cleanup_policy="none",
    )
