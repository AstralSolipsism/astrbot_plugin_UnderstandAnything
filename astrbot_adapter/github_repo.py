from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import re
import shutil
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .constants import PLUGIN_NAME, PLUGIN_ROOT
from .runtime_tools import detect_tool

GITHUB_PROXY_PRESETS = (
    "https://edgeone.gh-proxy.com",
    "https://hk.gh-proxy.com",
    "https://gh-proxy.com",
    "https://gh.llkk.cc",
)
DEFAULT_GIT_COMMAND_TIMEOUT_SECONDS = 300
GitProgressCallback = Callable[[str], Awaitable[None] | None]


class GitHubRepoError(ValueError):
    """Raised when a GitHub repository URL or checkout cannot be prepared."""


@dataclass(frozen=True, slots=True)
class GitCommandResult:
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True, slots=True)
class GitHubRepoCheckout:
    owner: str
    repo: str
    repo_url: str
    target_url: str
    clone_url: str
    github_proxy: str | None
    ref: str | None
    subpath: str | None
    worktree_path: Path
    artifact_root: Path
    cache_key: str
    source_key: str

    @property
    def display_name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def aliases(self) -> list[str]:
        values = [self.display_name, self.repo_url]
        if self.target_url != self.repo_url:
            values.append(self.target_url)
        if self.ref:
            values.append(f"{self.display_name}@{self.ref}")
        if self.ref and self.subpath:
            values.append(f"{self.display_name}@{self.ref}:{self.subpath}")
        return values

    @property
    def analysis_root(self) -> Path:
        if not self.subpath:
            return self.worktree_path
        return self.worktree_path.joinpath(*self.subpath.split("/"))

    @property
    def graph_root(self) -> Path:
        return self.artifact_root / ".understand-anything"


@dataclass(frozen=True, slots=True)
class GitHubRepoUrlParts:
    owner: str
    repo: str
    tree_parts: tuple[str, ...]


_OWNER_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_REF_RE = re.compile(r"^[A-Za-z0-9._/-]+$")


class GitHubRepoManager:
    def __init__(
        self,
        *,
        git_bin: str = "git",
        cache_root: str | Path | None = None,
        artifact_root: str | Path | None = None,
        git_timeout_seconds: int | float | None = None,
    ) -> None:
        if git_bin and git_bin != "git":
            self.git_bin = git_bin
        else:
            detected_git = detect_tool("git", "UA_GIT_BIN")
            self.git_bin = detected_git.path or detected_git.command
        self.cache_root = Path(cache_root) if cache_root else self.default_cache_root()
        self.cache_root = self.cache_root.expanduser().resolve(strict=False)
        self.artifact_root = (
            Path(artifact_root) if artifact_root else self.default_artifact_root()
        )
        self.artifact_root = self.artifact_root.expanduser().resolve(strict=False)
        self.git_timeout_seconds = max(
            0.001,
            float(
                git_timeout_seconds
                if git_timeout_seconds is not None
                else DEFAULT_GIT_COMMAND_TIMEOUT_SECONDS
            ),
        )
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def default_cache_root() -> Path:
        try:
            from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

            return (
                Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "repos" / "github"
            )
        except Exception:
            return PLUGIN_ROOT / ".plugin_data" / "repos" / "github"

    @staticmethod
    def default_artifact_root() -> Path:
        try:
            from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

            return (
                Path(get_astrbot_plugin_data_path())
                / PLUGIN_NAME
                / "artifacts"
                / "github"
            )
        except Exception:
            return PLUGIN_ROOT / ".plugin_data" / "artifacts" / "github"

    @staticmethod
    def is_http_url(value: str | None) -> bool:
        text = (value or "").strip().lower()
        return text.startswith(("http://", "https://"))

    @staticmethod
    def looks_like_github_url(value: str | None) -> bool:
        text = (value or "").strip().lower()
        return text.startswith(("https://github.com/", "http://github.com/"))

    def resolve(
        self,
        repo_url: str,
        ref: str | None = None,
        github_proxy: str | None = None,
    ) -> GitHubRepoCheckout:
        parts = self.parse_repo_url(repo_url)
        selected_ref, subpath = self._resolve_tree_parts_sync(parts.tree_parts, ref)
        return self._checkout_from_parts(parts, selected_ref, subpath, github_proxy)

    def checkout_from_metadata(
        self,
        *,
        owner: str,
        repo: str,
        ref: str | None = None,
        subpath: str | None = None,
        github_proxy: str | None = None,
    ) -> GitHubRepoCheckout:
        self._validate_owner_repo(owner, repo)
        selected_ref = self._normalize_ref(ref)
        normalized_subpath = self._normalize_subpath(subpath)
        return self._checkout_from_parts(
            GitHubRepoUrlParts(owner=owner, repo=repo, tree_parts=()),
            selected_ref,
            normalized_subpath,
            github_proxy,
        )

    async def resolve_remote(
        self,
        repo_url: str,
        ref: str | None = None,
        github_proxy: str | None = None,
    ) -> GitHubRepoCheckout:
        parts = self.parse_repo_url(repo_url)
        selected_ref = self._normalize_ref(ref)
        subpath: str | None = None
        if selected_ref:
            subpath = self._subpath_from_tree_parts(parts.tree_parts[1:])
        elif parts.tree_parts:
            selected_ref, subpath = await self._resolve_tree_parts_remote(
                parts,
                github_proxy,
            )
        return self._checkout_from_parts(parts, selected_ref, subpath, github_proxy)

    def _checkout_from_parts(
        self,
        parts: GitHubRepoUrlParts,
        selected_ref: str | None,
        subpath: str | None,
        github_proxy: str | None = None,
    ) -> GitHubRepoCheckout:
        owner = parts.owner
        repo = parts.repo
        normalized_proxy = self.normalize_github_proxy(github_proxy)
        direct_clone_url = f"https://github.com/{owner}/{repo}.git"
        clone_url = self.apply_github_proxy(direct_clone_url, normalized_proxy)
        normalized_url = f"https://github.com/{owner}/{repo}"
        cache_key = self._cache_key(owner, repo, selected_ref)
        source_key = self._source_key(owner, repo, selected_ref, subpath)
        target_url = normalized_url
        if selected_ref:
            target_url += f"/tree/{selected_ref}"
            if subpath:
                target_url += f"/{subpath}"
        return GitHubRepoCheckout(
            owner=owner,
            repo=repo,
            repo_url=normalized_url,
            target_url=target_url,
            clone_url=clone_url,
            github_proxy=normalized_proxy,
            ref=selected_ref,
            subpath=subpath,
            worktree_path=self._worktree_path(owner, repo, selected_ref),
            artifact_root=self._artifact_path(owner, repo, source_key),
            cache_key=cache_key,
            source_key=source_key,
        )

    @staticmethod
    def github_proxy_presets() -> tuple[str, ...]:
        return GITHUB_PROXY_PRESETS

    @staticmethod
    def normalize_github_proxy(value: str | None) -> str | None:
        proxy = (value or "").strip().rstrip("/")
        if not proxy:
            return None
        allowed = {item.rstrip("/") for item in GITHUB_PROXY_PRESETS}
        if proxy not in allowed:
            raise GitHubRepoError(
                "Unsupported GitHub proxy. Choose one of the bundled AstrBot "
                "GitHub proxy presets."
            )
        return proxy

    @classmethod
    def apply_github_proxy(cls, clone_url: str, github_proxy: str | None) -> str:
        proxy = cls.normalize_github_proxy(github_proxy)
        return f"{proxy}/{clone_url}" if proxy else clone_url

    @classmethod
    def parse_repo_url(cls, repo_url: str) -> GitHubRepoUrlParts:
        raw = (repo_url or "").strip()
        if not raw:
            raise GitHubRepoError("GitHub repository URL is required.")
        parts = urlsplit(raw)
        if parts.scheme != "https":
            raise GitHubRepoError("Only public https://github.com URLs are supported.")
        if parts.username or parts.password:
            raise GitHubRepoError(
                "GitHub URLs with embedded credentials are not supported."
            )
        if parts.netloc.lower() != "github.com":
            raise GitHubRepoError("Only github.com repository URLs are supported.")

        path_parts = [unquote(part) for part in parts.path.split("/") if part]
        if len(path_parts) < 2:
            raise GitHubRepoError(
                "GitHub URL must look like https://github.com/owner/repo.",
            )
        owner = path_parts[0]
        repo = path_parts[1]
        if repo.endswith(".git"):
            repo = repo[:-4]
        cls._validate_owner_repo(owner, repo)

        tree_parts: tuple[str, ...] = ()
        if len(path_parts) > 2:
            if path_parts[2] != "tree":
                raise GitHubRepoError(
                    "Only /tree/<ref> GitHub repository URLs are supported."
                )
            tree_parts = tuple(path_parts[3:])
            if not tree_parts:
                raise GitHubRepoError("GitHub tree URL is missing a ref.")
            cls._validate_tree_parts(tree_parts)
        return GitHubRepoUrlParts(owner=owner, repo=repo, tree_parts=tree_parts)

    async def prepare(
        self,
        checkout: GitHubRepoCheckout,
        progress: GitProgressCallback | None = None,
    ) -> Path:
        lock = self._locks.setdefault(checkout.cache_key, asyncio.Lock())
        async with lock:
            path = checkout.worktree_path
            if path.exists() and not (path / ".git").is_dir():
                raise GitHubRepoError(
                    f"GitHub cache path exists but is not a git repo: {path}"
            )
            if not (path / ".git").is_dir():
                path.parent.mkdir(parents=True, exist_ok=True)
                await self._notify_progress(
                    progress,
                    f"Cloning GitHub repository {checkout.display_name}.",
                )
                await self._run_git(["clone", checkout.clone_url, str(path)])
            else:
                await self._notify_progress(
                    progress,
                    f"Refreshing cached GitHub repository {checkout.display_name}.",
                )
                await self._run_git(
                    ["-C", str(path), "remote", "set-url", "origin", checkout.clone_url]
                )
                await self._notify_progress(
                    progress,
                    f"Fetching latest changes for {checkout.display_name}.",
                )
                await self._run_git(["-C", str(path), "fetch", "--prune", "origin"])

            await self._notify_progress(
                progress,
                f"Checking out GitHub repository {checkout.display_name}.",
            )
            await self._checkout_ref(path, checkout.ref)
            return self._validate_analysis_root(checkout)

    def remove_cache(self, checkout: GitHubRepoCheckout) -> bool:
        path = checkout.worktree_path.resolve(strict=False)
        try:
            path.relative_to(self.cache_root)
        except ValueError as exc:
            raise GitHubRepoError(
                "GitHub cache cleanup path escaped cache root."
            ) from exc
        if not path.exists():
            return False
        if not (path / ".git").exists():
            raise GitHubRepoError(f"Refusing to remove non-git cache path: {path}")
        shutil.rmtree(path)
        return True

    def git_available(self) -> bool:
        try:
            proc = subprocess.run(
                [self.git_bin, "--version"],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return proc.returncode == 0

    async def _checkout_ref(self, path: Path, ref: str | None) -> None:
        if ref:
            remote_ref = f"refs/remotes/origin/{ref}^{{commit}}"
            if (
                await self._run_git(
                    ["-C", str(path), "rev-parse", "--verify", remote_ref], check=False
                )
            ).returncode == 0:
                await self._run_git(
                    [
                        "-C",
                        str(path),
                        "checkout",
                        "--force",
                        "--detach",
                        f"origin/{ref}",
                    ]
                )
                return

            local_ref = f"{ref}^{{commit}}"
            if (
                await self._run_git(
                    ["-C", str(path), "rev-parse", "--verify", local_ref], check=False
                )
            ).returncode == 0:
                await self._run_git(
                    ["-C", str(path), "checkout", "--force", "--detach", ref]
                )
                return

            await self._run_git(["-C", str(path), "fetch", "origin", ref])
            await self._run_git(
                ["-C", str(path), "checkout", "--force", "--detach", "FETCH_HEAD"]
            )
            return

        result = await self._run_git(
            [
                "-C",
                str(path),
                "symbolic-ref",
                "--quiet",
                "--short",
                "refs/remotes/origin/HEAD",
            ],
            check=False,
        )
        target = result.stdout.strip() if result.returncode == 0 else "HEAD"
        await self._run_git(
            ["-C", str(path), "checkout", "--force", "--detach", target]
        )

    async def _resolve_tree_parts_remote(
        self,
        parts: GitHubRepoUrlParts,
        github_proxy: str | None,
    ) -> tuple[str, str | None]:
        clone_url = self.apply_github_proxy(
            f"https://github.com/{parts.owner}/{parts.repo}.git",
            github_proxy,
        )
        known_refs = await self._list_remote_ref_names(clone_url)
        for size in range(len(parts.tree_parts), 0, -1):
            candidate = "/".join(parts.tree_parts[:size])
            if candidate in known_refs:
                return candidate, self._subpath_from_tree_parts(parts.tree_parts[size:])
        return self._resolve_tree_parts_sync(parts.tree_parts, None)

    async def _list_remote_ref_names(self, clone_url: str) -> set[str]:
        result = await self._run_git(["ls-remote", "--heads", "--tags", clone_url])
        refs: set[str] = set()
        for line in result.stdout.splitlines():
            columns = line.split()
            if len(columns) < 2:
                continue
            name = columns[1]
            if name.endswith("^{}"):
                name = name[:-3]
            if name.startswith("refs/heads/"):
                refs.add(name.removeprefix("refs/heads/"))
            elif name.startswith("refs/tags/"):
                refs.add(name.removeprefix("refs/tags/"))
        return refs

    async def _run_git(
        self,
        args: list[str],
        *,
        check: bool = True,
    ) -> GitCommandResult:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.git_bin,
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.git_timeout_seconds,
            )
        except TimeoutError as exc:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
            command = self._format_git_command(args)
            raise GitHubRepoError(
                "GitHub source preparation timed out after "
                f"{self.git_timeout_seconds:.0f}s while running: {command}. "
                "Check the network connection, choose a GitHub proxy, or retry later."
            ) from exc
        except OSError as exc:
            raise GitHubRepoError(f"Failed to execute git: {exc}") from exc

        result = GitCommandResult(
            returncode=proc.returncode,
            stdout=stdout_bytes.decode(errors="replace"),
            stderr=stderr_bytes.decode(errors="replace"),
        )
        if check and result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            if len(detail) > 800:
                detail = detail[:800] + "..."
            raise GitHubRepoError(
                detail or f"git exited with status {result.returncode}"
            )
        return result

    def _format_git_command(self, args: list[str]) -> str:
        return " ".join([self.git_bin, *args])

    @staticmethod
    async def _notify_progress(
        progress: GitProgressCallback | None,
        message: str,
    ) -> None:
        if progress is None:
            return
        result = progress(message)
        if inspect.isawaitable(result):
            await result

    def _worktree_path(self, owner: str, repo: str, ref: str | None) -> Path:
        owner_dir = self._safe_path_part(owner)
        if not ref:
            repo_dir = self._safe_path_part(repo)
        else:
            ref_slug = self._safe_path_part(ref.replace("/", "_"))[:48]
            ref_hash = hashlib.sha1(ref.encode("utf-8")).hexdigest()[:8]
            repo_dir = f"{self._safe_path_part(repo)}--{ref_slug}-{ref_hash}"
        path = (self.cache_root / owner_dir / repo_dir).resolve(strict=False)
        try:
            path.relative_to(self.cache_root)
        except ValueError as exc:
            raise GitHubRepoError(
                "Resolved GitHub cache path escaped cache root."
            ) from exc
        return path

    def _artifact_path(self, owner: str, repo: str, source_key: str) -> Path:
        path = (
            self.artifact_root
            / self._safe_path_part(owner)
            / self._safe_path_part(repo)
            / source_key
        ).resolve(strict=False)
        try:
            path.relative_to(self.artifact_root)
        except ValueError as exc:
            raise GitHubRepoError(
                "Resolved GitHub artifact path escaped artifact root."
            ) from exc
        return path

    def _validate_analysis_root(self, checkout: GitHubRepoCheckout) -> Path:
        analysis_root = checkout.analysis_root.resolve(strict=False)
        worktree_root = checkout.worktree_path.resolve(strict=False)
        try:
            analysis_root.relative_to(worktree_root)
        except ValueError as exc:
            raise GitHubRepoError(
                "GitHub analysis subpath escaped repository root."
            ) from exc
        if checkout.subpath and not analysis_root.is_dir():
            raise GitHubRepoError(
                f"GitHub repository subpath does not exist: {checkout.subpath}",
            )
        return analysis_root

    @staticmethod
    def _cache_key(owner: str, repo: str, ref: str | None) -> str:
        return f"{owner.casefold()}/{repo.casefold()}@{ref or 'default'}"

    @staticmethod
    def _source_key(owner: str, repo: str, ref: str | None, subpath: str | None) -> str:
        raw = f"{owner.casefold()}/{repo.casefold()}@{ref or 'default'}:{subpath or ''}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _safe_path_part(value: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._-")
        if not safe:
            raise GitHubRepoError("Invalid GitHub cache path component.")
        return safe

    @classmethod
    def _resolve_tree_parts_sync(
        cls,
        tree_parts: tuple[str, ...],
        ref: str | None,
    ) -> tuple[str | None, str | None]:
        selected_ref = cls._normalize_ref(ref)
        if selected_ref:
            return selected_ref, cls._subpath_from_tree_parts(tree_parts[1:])
        if not tree_parts:
            return None, None
        selected_ref = cls._normalize_ref(tree_parts[0])
        return selected_ref, cls._subpath_from_tree_parts(tree_parts[1:])

    @staticmethod
    def _subpath_from_tree_parts(parts: tuple[str, ...]) -> str | None:
        if not parts:
            return None
        return "/".join(parts)

    @classmethod
    def _normalize_subpath(cls, subpath: str | None) -> str | None:
        value = (subpath or "").strip().strip("/")
        if not value:
            return None
        parts = tuple(part for part in value.split("/") if part)
        cls._validate_tree_parts(parts)
        return "/".join(parts)

    @staticmethod
    def _normalize_ref(ref: str | None) -> str | None:
        value = (ref or "").strip()
        if not value:
            return None
        if (
            value.startswith(("-", "/", "."))
            or value.endswith(("/", "."))
            or "\\" in value
            or "//" in value
            or ".." in value
            or "@{" in value
            or not _REF_RE.match(value)
        ):
            raise GitHubRepoError(f"Unsupported GitHub ref: {value}")
        return value

    @staticmethod
    def _validate_tree_parts(parts: tuple[str, ...]) -> None:
        for part in parts:
            if (
                not part
                or part in {".", ".."}
                or "\\" in part
                or "/" in part
                or "\x00" in part
            ):
                raise GitHubRepoError(f"Unsupported GitHub URL path segment: {part}")

    @staticmethod
    def _validate_owner_repo(owner: str, repo: str) -> None:
        if not _OWNER_RE.match(owner):
            raise GitHubRepoError(f"Invalid GitHub owner: {owner}")
        if (
            not _REPO_RE.match(repo)
            or repo in {".", ".."}
            or repo.startswith(".")
            or repo.endswith(".")
        ):
            raise GitHubRepoError(f"Invalid GitHub repository name: {repo}")
