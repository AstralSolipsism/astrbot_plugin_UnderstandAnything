# ruff: noqa: E402

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from quart import Quart

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from astrbot_adapter.github_repo import (
    GitCommandResult,
    GitHubRepoError,
    GitHubRepoManager,
)
from astrbot_adapter.job_request import format_job_args, parse_job_args
from astrbot_adapter.job_store import JobStatus, JobStore
from astrbot_adapter.path_security import PathSecurity, PathSecurityError
from astrbot_adapter.project_registry import ProjectRegistry, ProjectRegistryError
from astrbot_adapter.project_store import ProjectStore
from astrbot_adapter.runner import UnderstandAnythingRunner
from astrbot_adapter.runtime import UnderstandAnythingRuntime
from astrbot_adapter.runtime_tools import (
    RuntimeToolset,
    RuntimeToolStatus,
    detect_runtime_tools,
    runtime_readiness,
)
from astrbot_adapter.subagent_dispatcher import UnderstandAnythingSubAgentDispatcher
from astrbot_adapter.subagent_registry import (
    ROLE_NAMES,
    UA_AGENT_TOOLS,
    UA_PERSONA_FOLDER_NAME,
    UA_ROLE_SKILLS,
    UnderstandAnythingSubAgentRegistry,
)
from astrbot_adapter.web_api import UnderstandAnythingWebApi


def test_plugin_main_uses_package_relative_adapter_imports() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert "from astrbot_adapter" not in source
    assert "from .astrbot_adapter" in source


def test_dashboard_page_bundle_is_plugin_page_safe() -> None:
    source_html = (
        PLUGIN_ROOT / "understand-anything" / "packages" / "dashboard" / "index.html"
    ).read_text(encoding="utf-8")
    page_html = (PLUGIN_ROOT / "pages" / "dashboard" / "index.html").read_text(
        encoding="utf-8",
    )
    js_assets = list((PLUGIN_ROOT / "pages" / "dashboard" / "assets").glob("*.js"))

    bridge_index = source_html.index("/api/plugin/page/bridge-sdk.js")
    app_index = source_html.index("/src/main.tsx")
    page_bridge_index = page_html.index("/api/plugin/page/bridge-sdk.js")
    page_app_index = page_html.index('type="module"')
    assert bridge_index < app_index
    assert page_bridge_index < page_app_index
    assert "i18n_scope" in source_html
    assert '"page"' in source_html
    assert "i18n_scope" in page_html
    assert '"page"' in page_html
    assert "asset_token" in source_html
    assert "asset_token" in page_html
    assert 'rel="modulepreload"' not in page_html
    assert len(js_assets) == 1


def test_path_security_allows_paths_inside_allowed_root(tmp_path: Path) -> None:
    allowed_root = tmp_path / "workspace"
    allowed_root.mkdir()
    nested = allowed_root / "project"
    nested.mkdir()

    security = PathSecurity([allowed_root])

    assert security.resolve_project_path(str(nested)) == nested.resolve()


def test_path_security_rejects_paths_outside_allowed_root(tmp_path: Path) -> None:
    allowed_root = tmp_path / "workspace"
    other_root = tmp_path / "other"
    allowed_root.mkdir()
    other_root.mkdir()

    security = PathSecurity([allowed_root])

    with pytest.raises(PathSecurityError):
        security.resolve_project_path(str(other_root))


def test_path_security_allows_any_existing_project_without_allowed_roots(
    tmp_path: Path,
) -> None:
    project = tmp_path / "external-project"
    project.mkdir()
    security = PathSecurity()

    assert security.resolve_project_path(str(project)) == project.resolve()


def test_path_security_rejects_non_directory_project_without_allowed_roots(
    tmp_path: Path,
) -> None:
    file_path = tmp_path / "not-a-project.txt"
    file_path.write_text("not a directory", encoding="utf-8")
    security = PathSecurity()

    with pytest.raises(PathSecurityError, match="Project path is not a directory"):
        security.resolve_project_path(str(file_path))


def test_project_store_reads_graph_files_and_restricts_file_content(
    tmp_path: Path,
) -> None:
    project_root = tmp_path / "project"
    source_dir = project_root / "src"
    graph_dir = project_root / ".understand-anything"
    source_dir.mkdir(parents=True)
    graph_dir.mkdir()
    source_file = source_dir / "app.py"
    source_file.write_bytes(b"print('ok')\n")
    ungraphed_file = project_root / "pyproject.toml"
    ungraphed_file.write_bytes(b"[project]\nname = 'demo'\n")
    graph = {
        "version": "1.0.0",
        "project": {
            "name": "demo",
            "languages": ["python"],
            "frameworks": [],
            "description": "",
            "analyzedAt": "2026-05-11T00:00:00Z",
            "gitCommitHash": "abc",
        },
        "nodes": [
            {
                "id": "file:src/app.py",
                "type": "file",
                "name": "app.py",
                "filePath": "src/app.py",
                "summary": "Demo file",
                "tags": [],
                "complexity": "simple",
            }
        ],
        "edges": [],
        "layers": [],
        "tour": [],
    }
    (graph_dir / "knowledge-graph.json").write_text(
        json.dumps(graph),
        encoding="utf-8",
    )

    store = ProjectStore(project_root)

    assert store.read_json("knowledge-graph.json")["project"]["name"] == "demo"
    source = store.read_source_file("src/app.py")
    assert source["content"] == "print('ok')\n"
    assert store.read_source_file("pyproject.toml")["content"] == (
        "[project]\nname = 'demo'\n"
    )

    with pytest.raises(PathSecurityError):
        store.read_source_file("../outside.py")

    outside_file = tmp_path / "outside.py"
    outside_file.write_text("print('outside')\n", encoding="utf-8")
    with pytest.raises(PathSecurityError):
        store.read_source_file(str(outside_file))

    binary_file = project_root / "binary.dat"
    binary_file.write_bytes(b"abc\0def")
    with pytest.raises(ValueError, match="Binary files cannot be previewed"):
        store.read_source_file("binary.dat")

    oversized_file = project_root / "large.txt"
    oversized_file.write_bytes(b"x" * 4)
    small_limit_store = ProjectStore(project_root, max_source_file_bytes=3)
    with pytest.raises(ValueError, match="File is too large"):
        small_limit_store.read_source_file("large.txt")


def test_project_store_reads_graph_from_separate_graph_root(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "source-cache"
    source_dir = source_root / "src"
    graph_root = (
        tmp_path
        / "artifacts"
        / "github"
        / "owner"
        / "repo"
        / "target"
        / ".understand-anything"
    )
    source_dir.mkdir(parents=True)
    graph_root.mkdir(parents=True)
    (source_dir / "app.py").write_bytes(b"print('artifact')\n")
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps(
            {
                "project": {"name": "artifact graph"},
                "nodes": [
                    {
                        "id": "file:src/app.py",
                        "type": "file",
                        "name": "app.py",
                        "filePath": "src/app.py",
                        "summary": "Demo file",
                    }
                ],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    source_graph_root = source_root / ".understand-anything"
    source_graph_root.mkdir()
    (source_graph_root / "knowledge-graph.json").write_text(
        json.dumps({"project": {"name": "source graph"}, "nodes": [], "edges": []}),
        encoding="utf-8",
    )

    store = ProjectStore(source_root, graph_root=graph_root)

    assert (
        store.read_json("knowledge-graph.json")["project"]["name"] == "artifact graph"
    )
    assert store.read_source_file("src/app.py")["content"] == "print('artifact')\n"


def test_job_store_tracks_lifecycle() -> None:
    jobs = JobStore()

    job = jobs.create("understand", Path("D:/project"), {"full": True})
    jobs.append_log(job.job_id, "started")
    jobs.mark_running(job.job_id)
    jobs.mark_finished(job.job_id, {"graph": "knowledge-graph.json"})

    snapshot = jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert snapshot.logs == ["started"]
    assert snapshot.result == {"graph": "knowledge-graph.json"}


def test_project_registry_registers_and_resolves_by_id_name_alias(
    tmp_path: Path,
) -> None:
    project = tmp_path / "Project With Spaces"
    graph_root = project / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        '{"project": {"name": "Graph Project"}}',
        encoding="utf-8",
    )
    registry = ProjectRegistry(tmp_path / "projects.json")
    security = PathSecurity([tmp_path])

    record = registry.register(project, job_id="job-1", aliases=["main"])
    assert record.name == "Graph Project"
    assert registry.resolve(security, project_id=record.project_id) == project.resolve()
    assert registry.resolve(security, project_name="Graph Project") == project.resolve()
    assert registry.resolve(security, project_ref="main") == project.resolve()

    updated = registry.register(project, job_id="job-2", auto_update=True)
    assert updated.last_job_id == "job-2"
    assert updated.auto_update is True


def test_project_registry_records_separate_source_and_graph_root(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "repos" / "github" / "owner" / "repo--main"
    graph_root = (
        tmp_path
        / "artifacts"
        / "github"
        / "owner"
        / "repo"
        / "source-key"
        / ".understand-anything"
    )
    source_root.mkdir(parents=True)
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        '{"project": {"name": "GitHub Graph"}}',
        encoding="utf-8",
    )
    registry = ProjectRegistry(tmp_path / "projects.json")
    security = PathSecurity([tmp_path])

    record = registry.register(
        source_root,
        graph_root=graph_root,
        source={
            "type": "github",
            "repo_url": "https://github.com/owner/repo",
            "cache_path": str(source_root),
            "artifact_root": str(graph_root.parent),
            "graph_root": str(graph_root),
            "source_key": "source-key",
        },
        aliases=["owner/repo"],
    )

    assert record.project_id == ProjectRegistry.project_id_for(graph_root.parent)
    assert record.name == "GitHub Graph"
    assert record.path == str(source_root.resolve())
    assert record.graph_root == str(graph_root.resolve())
    assert record.source["type"] == "github"
    assert (
        registry.resolve(security, project_id=record.project_id)
        == source_root.resolve()
    )
    assert registry.resolve_record(project_ref="owner/repo").graph_root == str(
        graph_root.resolve()
    )


def test_project_registry_requires_explicit_project_when_ambiguous(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    registry = ProjectRegistry(tmp_path / "projects.json")
    registry.register(first)
    registry.register(second)

    with pytest.raises(ProjectRegistryError, match="Multiple Understand Anything"):
        registry.resolve(PathSecurity([tmp_path]))


def test_structured_job_request_keeps_path_with_spaces(tmp_path: Path) -> None:
    project = tmp_path / "Project With Spaces"
    project.mkdir()
    raw_args = format_job_args(project.resolve(), ["--full"])
    parsed = parse_job_args(raw_args)

    assert "Project With Spaces" in raw_args
    assert parsed.path == str(project.resolve())
    assert parsed.flags == ["--full"]


def test_job_request_parses_github_ref_without_treating_it_as_flag() -> None:
    parsed = parse_job_args(
        "https://github.com/AstralSolipsism/demo --ref main --full",
    )

    assert parsed.path == "https://github.com/AstralSolipsism/demo"
    assert parsed.git_ref == "main"
    assert parsed.flags == ["--full"]


def test_github_repo_url_parser_accepts_public_repo_forms(tmp_path: Path) -> None:
    manager = GitHubRepoManager(
        cache_root=tmp_path / "cache",
        artifact_root=tmp_path / "artifacts",
    )

    checkout = manager.resolve("https://github.com/AstralSolipsism/demo.git")
    assert checkout.owner == "AstralSolipsism"
    assert checkout.repo == "demo"
    assert checkout.ref is None
    assert checkout.subpath is None
    assert checkout.clone_url == "https://github.com/AstralSolipsism/demo.git"
    assert (
        checkout.worktree_path
        == tmp_path.resolve() / "cache" / "AstralSolipsism" / "demo"
    )
    assert (
        checkout.artifact_root.parent
        == tmp_path.resolve() / "artifacts" / "AstralSolipsism" / "demo"
    )
    assert checkout.graph_root == checkout.artifact_root / ".understand-anything"
    assert checkout.source_key

    proxied = manager.resolve(
        "https://github.com/AstralSolipsism/demo",
        github_proxy="https://gh.llkk.cc/",
    )
    assert proxied.github_proxy == "https://gh.llkk.cc"
    assert (
        proxied.clone_url
        == "https://gh.llkk.cc/https://github.com/AstralSolipsism/demo.git"
    )

    tree_checkout = manager.resolve(
        "https://github.com/AstralSolipsism/demo/tree/dev/packages/app",
    )
    assert tree_checkout.ref == "dev"
    assert tree_checkout.subpath == "packages/app"
    assert tree_checkout.worktree_path.name.startswith("demo--dev-")

    explicit_ref = manager.resolve(
        "https://github.com/AstralSolipsism/demo/tree/dev/packages/app",
        "main",
    )
    assert explicit_ref.ref == "main"
    assert explicit_ref.subpath == "packages/app"

    from_metadata = manager.checkout_from_metadata(
        owner="AstralSolipsism",
        repo="demo",
        ref="feature/x",
        subpath="packages/app",
    )
    assert from_metadata.target_url.endswith("/tree/feature/x/packages/app")
    assert from_metadata.worktree_path.name.startswith("demo--feature_x-")
    assert from_metadata.source_key != tree_checkout.source_key


@pytest.mark.parametrize(
    "repo_url",
    [
        "http://github.com/AstralSolipsism/demo",
        "https://gitlab.com/AstralSolipsism/demo",
        "https://user:token@github.com/AstralSolipsism/demo",
        "https://github.com/AstralSolipsism",
        "https://github.com/AstralSolipsism/demo/issues",
    ],
)
def test_github_repo_url_parser_rejects_unsupported_urls(
    repo_url: str,
    tmp_path: Path,
) -> None:
    manager = GitHubRepoManager(
        cache_root=tmp_path / "cache",
        artifact_root=tmp_path / "artifacts",
    )

    with pytest.raises(GitHubRepoError):
        manager.resolve(repo_url)


def test_github_repo_manager_rejects_unknown_proxy(tmp_path: Path) -> None:
    manager = GitHubRepoManager(
        cache_root=tmp_path / "cache",
        artifact_root=tmp_path / "artifacts",
    )

    with pytest.raises(GitHubRepoError, match="Unsupported GitHub proxy"):
        manager.resolve(
            "https://github.com/AstralSolipsism/demo",
            github_proxy="https://example.com",
        )


class _FakeGitHubRepoManager(GitHubRepoManager):
    def __init__(
        self,
        cache_root: Path,
        *,
        fail_clone: bool = False,
        remote_refs: list[str] | None = None,
        create_subpath: str | None = None,
        create_files: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            cache_root=cache_root,
            artifact_root=cache_root.parent / "github-artifacts",
        )
        self.fail_clone = fail_clone
        self.remote_refs = remote_refs or ["main"]
        self.create_subpath = create_subpath
        self.create_files = create_files or {}
        self.calls: list[list[str]] = []

    async def _run_git(
        self, args: list[str], *, check: bool = True
    ) -> GitCommandResult:
        self.calls.append(args)
        if args[0] == "ls-remote":
            stdout = "".join(
                f"abc123\trefs/heads/{remote_ref}\n" for remote_ref in self.remote_refs
            )
            return GitCommandResult(0, stdout, "")
        if args[0] == "clone":
            if self.fail_clone:
                raise GitHubRepoError("clone failed")
            Path(args[-1], ".git").mkdir(parents=True)
            if self.create_subpath:
                Path(args[-1], self.create_subpath).mkdir(parents=True)
            for relative_path, content in self.create_files.items():
                file_path = Path(args[-1], relative_path)
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(content.encode("utf-8"))
            return GitCommandResult(0, "", "")
        if "symbolic-ref" in args:
            return GitCommandResult(0, "origin/main\n", "")
        if "rev-parse" in args:
            return GitCommandResult(1, "", "missing")
        return GitCommandResult(0, "", "")


@pytest.mark.asyncio
async def test_github_repo_manager_clones_then_updates_cached_repo(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(tmp_path)
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")

    await manager.prepare(checkout)
    await manager.prepare(checkout)

    clone_calls = [call for call in manager.calls if call[0] == "clone"]
    fetch_calls = [call for call in manager.calls if "fetch" in call]
    assert len(clone_calls) == 1
    assert fetch_calls


@pytest.mark.asyncio
async def test_github_repo_manager_resolves_slash_ref_and_subpath_from_remote(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(
        tmp_path,
        remote_refs=["feature/x", "feature/x/packages"],
    )

    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/feature/x/packages/app",
    )

    assert checkout.ref == "feature/x/packages"
    assert checkout.subpath == "app"


@pytest.mark.asyncio
async def test_github_repo_manager_returns_analysis_subpath_after_prepare(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(tmp_path, create_subpath="packages/app")
    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
    )

    analysis_root = await manager.prepare(checkout)

    assert analysis_root == checkout.worktree_path / "packages" / "app"


@pytest.mark.asyncio
async def test_github_repo_manager_rejects_missing_analysis_subpath(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(tmp_path)
    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
    )

    with pytest.raises(GitHubRepoError, match="subpath does not exist"):
        await manager.prepare(checkout)


@pytest.mark.asyncio
async def test_github_repo_manager_reports_clone_failure(tmp_path: Path) -> None:
    manager = _FakeGitHubRepoManager(tmp_path, fail_clone=True)
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")

    with pytest.raises(GitHubRepoError, match="clone failed"):
        await manager.prepare(checkout)


@pytest.mark.asyncio
async def test_github_cache_cleanup_keeps_artifacts_readable(tmp_path: Path) -> None:
    manager = _FakeGitHubRepoManager(tmp_path / "github-cache")
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")
    await manager.prepare(checkout)
    checkout.graph_root.mkdir(parents=True)
    (checkout.graph_root / "knowledge-graph.json").write_text(
        json.dumps(
            {
                "project": {"name": "artifact survives"},
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    (checkout.graph_root / "meta.json").write_text(
        json.dumps({"gitCommitHash": "abc"}),
        encoding="utf-8",
    )
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={"cleanup_github_cache_after_analysis": True},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = manager
    runner.security = PathSecurity(
        [],
        implicit_roots=[manager.cache_root, manager.artifact_root],
    )
    record = runner.registry.register(
        checkout.analysis_root,
        graph_root=checkout.graph_root,
        source=runner._github_source_payload(checkout),
    )
    job = runner.jobs.create(
        "understand",
        checkout.analysis_root,
        {
            "source": runner._github_source_payload(checkout),
            "graph_root": str(checkout.graph_root),
        },
    )

    runner._cleanup_github_cache_after_job(job)

    assert not checkout.worktree_path.exists()
    store = runner.project_store(project_id=record.project_id)
    assert (
        store.read_json("knowledge-graph.json")["project"]["name"]
        == "artifact survives"
    )
    assert store.read_json("meta.json")["gitCommitHash"] == "abc"


@pytest.mark.asyncio
async def test_runner_rehydrates_cleaned_github_source_from_registry(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(
        tmp_path / "github-cache",
        create_subpath="packages/app",
    )
    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
    )
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = manager
    record = runner.registry.register(
        checkout.analysis_root,
        graph_root=checkout.graph_root,
        source=runner._github_source_payload(checkout),
    )

    assert not checkout.analysis_root.exists()

    await runner.ensure_project_source_ready(project_id=record.project_id)

    assert checkout.analysis_root.is_dir()
    assert any(call[0] == "clone" for call in manager.calls)


@pytest.mark.asyncio
async def test_runner_restarts_github_analysis_from_registered_source_metadata(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(tmp_path / "github-cache")
    checkout = manager.checkout_from_metadata(
        owner="AstralSolipsism",
        repo="demo",
        ref="feature/x",
        subpath="packages/app",
    )
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = manager
    record = runner.registry.register(
        checkout.analysis_root,
        graph_root=checkout.graph_root,
        source=runner._github_source_payload(checkout),
    )

    job = await runner.start_skill_job(
        skill_name="understand",
        project_id=record.project_id,
        start_task=False,
    )

    assert job.args["source"]["type"] == "github"  # type: ignore[index]
    assert job.args["source"]["ref"] == "feature/x"  # type: ignore[index]
    assert job.args["source"]["subpath"] == "packages/app"  # type: ignore[index]
    assert job.project_root == checkout.analysis_root
    assert job.args["graph_root"] == str(checkout.graph_root)


@pytest.mark.asyncio
async def test_file_content_rehydrates_github_source_after_cache_cleanup(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(
        tmp_path / "github-cache",
        create_subpath="packages/app",
        create_files={"packages/app/src/app.py": "print('ok')\n"},
    )
    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
    )
    checkout.graph_root.mkdir(parents=True)
    (checkout.graph_root / "knowledge-graph.json").write_text(
        json.dumps(
            {
                "project": {"name": "demo"},
                "nodes": [
                    {
                        "id": "file:src/app.py",
                        "type": "file",
                        "name": "app.py",
                        "filePath": "src/app.py",
                        "summary": "Demo file",
                    }
                ],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = manager
    runner.security = PathSecurity(
        [],
        implicit_roots=[manager.cache_root, manager.artifact_root],
    )
    record = runner.registry.register(
        checkout.analysis_root,
        graph_root=checkout.graph_root,
        source=runner._github_source_payload(checkout),
    )
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/file-content"
        f"?project_id={record.project_id}&path=src/app.py",
        method="GET",
    ):
        response = await api.file_content()

    assert (await response.get_json())["data"]["content"] == "print('ok')\n"
    assert checkout.analysis_root.is_dir()


def test_runner_creates_github_job_without_allowed_roots_configuration(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = GitHubRepoManager(
        cache_root=tmp_path / "github-cache",
        artifact_root=tmp_path / "github-artifacts",
    )

    job = asyncio.run(
        runner.start_skill_job(
            skill_name="understand",
            repo_url="https://github.com/AstralSolipsism/demo",
            ref="main",
            start_task=False,
        ),
    )

    assert job.args["source"]["type"] == "github"  # type: ignore[index]
    assert job.args["source"]["display_name"] == "AstralSolipsism/demo"  # type: ignore[index]
    assert (
        job.project_root
        == tmp_path.resolve()
        / "github-cache"
        / "AstralSolipsism"
        / "demo--main-b28b7af6"
    )
    assert Path(str(job.args["graph_root"])).is_relative_to(
        tmp_path.resolve() / "github-artifacts",
    )
    assert job.args["source"]["cache_path"] == str(job.project_root)  # type: ignore[index]
    assert job.args["source"]["artifact_root"] == str(
        Path(str(job.args["graph_root"])).parent
    )  # type: ignore[index]


def test_runner_accepts_single_target_for_github_and_local_paths(
    tmp_path: Path,
) -> None:
    local_project = tmp_path / "local-project"
    local_project.mkdir()
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = GitHubRepoManager(
        cache_root=tmp_path / "github-cache",
        artifact_root=tmp_path / "github-artifacts",
    )

    github_job = asyncio.run(
        runner.start_skill_job(
            skill_name="understand",
            target="https://github.com/AstralSolipsism/demo/tree/main/packages/app",
            start_task=False,
        ),
    )
    local_job = asyncio.run(
        runner.start_skill_job(
            skill_name="understand",
            target=str(local_project),
            start_task=False,
        ),
    )

    assert github_job.args["source"]["type"] == "github"  # type: ignore[index]
    assert github_job.args["source"]["subpath"] == "packages/app"  # type: ignore[index]
    assert Path(str(github_job.args["graph_root"])).is_relative_to(
        tmp_path.resolve() / "github-artifacts",
    )
    assert local_job.args["source"]["type"] == "local"  # type: ignore[index]
    assert local_job.project_root == local_project.resolve()


def test_runner_rejects_non_github_http_target(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )

    with pytest.raises(GitHubRepoError, match="github.com"):
        asyncio.run(
            runner.start_skill_job(
                skill_name="understand",
                target="https://gitlab.com/AstralSolipsism/demo",
                start_task=False,
            ),
        )


@pytest.mark.asyncio
async def test_web_api_start_job_maps_single_target_to_runner(tmp_path: Path) -> None:
    class Job:
        def to_dict(self) -> dict[str, str]:
            return {"job_id": "job-1"}

    class DummyRunner:
        config: dict[str, object] = {}
        github = GitHubRepoManager(
            cache_root=tmp_path / "github-cache",
            artifact_root=tmp_path / "github-artifacts",
        )
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        async def start_skill_job(self, **kwargs):
            self.calls.append(kwargs)
            return Job()

    runner = DummyRunner()
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/jobs/start",
        method="POST",
        json={
            "action": "understand",
            "target": "https://github.com/AstralSolipsism/demo/tree/main/packages/app",
            "full": True,
            "github_proxy": "https://gh.llkk.cc",
        },
    ):
        response = await api.start_job()

    assert (await response.get_json())["status"] == "ok"
    assert (
        runner.calls[-1]["repo_url"]
        == "https://github.com/AstralSolipsism/demo/tree/main/packages/app"
    )
    assert runner.calls[-1]["project_path"] is None
    assert runner.calls[-1]["flags"] == ["--full"]
    assert runner.calls[-1]["github_proxy"] == "https://gh.llkk.cc"

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/jobs/start",
        method="POST",
        json={
            "action": "understand",
            "target": str(tmp_path),
        },
    ):
        response = await api.start_job()

    assert (await response.get_json())["status"] == "ok"
    assert runner.calls[-1]["repo_url"] is None
    assert runner.calls[-1]["project_path"] == str(tmp_path)


@pytest.mark.asyncio
async def test_web_api_runtime_repair_delegates_to_plugin_runtime(
    tmp_path: Path,
) -> None:
    class DummyRuntime:
        def __init__(self) -> None:
            self.called = False

        def tools(self) -> RuntimeToolset:
            return RuntimeToolset(
                node=_runtime_tool("node"),
                pnpm=_runtime_tool("pnpm"),
                git=_runtime_tool("git"),
            )

        async def repair(self) -> dict[str, object]:
            self.called = True
            return {
                "actions": ["pnpm install --frozen-lockfile"],
                "ready": True,
            }

    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

        def __init__(self) -> None:
            self.runtime = DummyRuntime()

    runner = DummyRunner()
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/runtime/repair",
        method="POST",
        json={},
    ):
        response = await api.repair_runtime()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["ready"] is True
    assert runner.runtime.called is True


def test_project_registry_default_resolution_is_not_last_project_global(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    registry = ProjectRegistry(tmp_path / "projects.json")
    registry.register(first)
    registry.register(second)

    with pytest.raises(ProjectRegistryError, match="Multiple Understand Anything"):
        registry.resolve(PathSecurity([tmp_path]))


def _runtime_tool(
    name: str,
    *,
    available: bool = True,
    supported: bool = True,
    version: str = "v99.0.0",
) -> RuntimeToolStatus:
    return RuntimeToolStatus(
        name=name,
        command=name,
        path=f"/usr/bin/{name}" if available else "",
        available=available,
        supported=supported,
        version=version if available else "",
        source="path",
        blocking_reason="" if supported else f"{name} unavailable",
    )


def test_runtime_tool_detection_reports_missing_path_tools(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.delenv("UA_NODE_BIN", raising=False)
    monkeypatch.delenv("UA_PNPM_BIN", raising=False)
    monkeypatch.delenv("UA_GIT_BIN", raising=False)

    tools = detect_runtime_tools()
    readiness = runtime_readiness(
        tmp_path / "understand-anything",
        tools,
        auto_repair_enabled=True,
    )

    assert tools.node.available is False
    assert tools.pnpm.available is False
    assert tools.git.available is False
    assert readiness["local_analysis_ready"] is False
    assert readiness["github_analysis_ready"] is False
    assert readiness["repair_available"] is False
    assert readiness["blocking_reasons"]


def test_runtime_readiness_allows_local_analysis_without_git(
    tmp_path: Path,
) -> None:
    runtime_root = tmp_path / "understand-anything"
    (runtime_root / "node_modules").mkdir(parents=True)
    (runtime_root / "packages" / "core" / "dist").mkdir(parents=True)
    (runtime_root / "packages" / "core" / "dist" / "index.js").write_text(
        "export {};",
        encoding="utf-8",
    )
    (runtime_root / "dist").mkdir()
    (runtime_root / "dist" / "index.js").write_text("export {};", encoding="utf-8")

    readiness = runtime_readiness(
        runtime_root,
        RuntimeToolset(
            node=_runtime_tool("node"),
            pnpm=_runtime_tool("pnpm"),
            git=_runtime_tool("git", available=False, supported=False),
        ),
        auto_repair_enabled=True,
    )

    assert readiness["local_analysis_ready"] is True
    assert readiness["github_analysis_ready"] is False
    assert "git" in readiness["github_blocking_reason"].lower()


@pytest.mark.asyncio
async def test_runtime_repair_runs_only_inside_bundled_runtime(
    tmp_path: Path,
) -> None:
    runtime_root = tmp_path / "plugin" / "understand-anything"
    runtime_root.mkdir(parents=True)
    runtime = UnderstandAnythingRuntime(auto_build=True)
    runtime.root = runtime_root

    calls: list[tuple[str, ...]] = []

    async def fake_run(*command: str, capture: bool = False) -> str:
        assert capture is False
        calls.append(command)
        assert runtime.root == runtime_root
        if "install" in command:
            (runtime_root / "node_modules").mkdir()
        if "@understand-anything/core" in command:
            core_dist = runtime_root / "packages" / "core" / "dist"
            core_dist.mkdir(parents=True)
            (core_dist / "index.js").write_text("export {};", encoding="utf-8")
        elif "build" in command:
            dist = runtime_root / "dist"
            dist.mkdir()
            (dist / "index.js").write_text("export {};", encoding="utf-8")
        return ""

    runtime.tools = lambda: RuntimeToolset(  # type: ignore[method-assign]
        node=_runtime_tool("node"),
        pnpm=_runtime_tool("pnpm"),
        git=_runtime_tool("git"),
    )
    runtime._run = fake_run  # type: ignore[method-assign]

    result = await runtime.repair()

    assert result["ready"] is True
    assert result["actions"] == [
        "pnpm install --frozen-lockfile",
        "pnpm --filter @understand-anything/core build",
        "pnpm build",
    ]
    assert all(str(runtime_root) not in " ".join(command) for command in calls)
    assert not (tmp_path / "node_modules").exists()


def test_web_api_status_summarizes_config_without_provider_secret(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config = {
            "provider_id": "secret-provider-id",
            "subagent_provider_id": "secret-subagent-provider-id",
            "auto_build": False,
            "auto_update_poll_interval": 30,
            "max_concurrent_jobs": 2,
            "max_parallel_file_agents": 4,
            "max_parallel_article_agents": 2,
            "default_write_mode": "project",
            "cleanup_github_cache_after_analysis": True,
        }
        security = PathSecurity([tmp_path])
        runtime = SimpleNamespace(
            tools=lambda: RuntimeToolset(
                node=_runtime_tool("node"),
                pnpm=_runtime_tool("pnpm"),
                git=_runtime_tool("git"),
            ),
        )

    api = UnderstandAnythingWebApi(context=None, runner=DummyRunner())  # type: ignore[arg-type]
    routes = {route for route, *_ in api.routes()}
    payload = api.status_payload()

    assert "/astrbot_plugin_UnderstandAnything/status" in routes
    assert "/astrbot_plugin_UnderstandAnything/runtime/repair" in routes
    assert "/astrbot_plugin_UnderstandAnything/subagents/providers" in routes
    assert payload["plugin"]["name"] == "astrbot_plugin_UnderstandAnything"
    assert payload["config"]["provider_configured"] is True
    assert "node_bin" not in payload["config"]
    assert "pnpm_bin" not in payload["config"]
    assert "git_bin" not in payload["config"]
    assert "git_available" not in payload["config"]
    assert payload["runtime"]["tools"]["node"]["supported"] is True
    assert payload["runtime"]["tools"]["git"]["available"] is True
    assert payload["config"]["cleanup_github_cache_after_analysis"] is True
    assert "allowed_roots" not in payload["config"]
    assert payload["config"]["subagent_provider_configured"] is True
    assert payload["config"]["max_parallel_file_agents"] == 4
    assert payload["config"]["max_parallel_article_agents"] == 2
    assert payload["subagents"]["ready"] is False
    assert "provider_id" not in payload["config"]
    assert "secret-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert "secret-subagent-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert payload["runtime"]["dashboard_page"]["exists"] is True


def test_web_api_status_reports_astrbot_computer_use_runtime(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    for runtime, enabled, blocking_reason in [
        ("none", False, "disabled"),
        ("local", True, ""),
        ("sandbox", True, ""),
    ]:
        context = _RegistryContext(
            _DummyConfig(
                {
                    "provider_settings": {
                        "computer_use_runtime": runtime,
                        "computer_use_require_admin": False,
                        "sandbox": {"booter": "shipyard_neo"},
                    }
                }
            )
        )
        api = UnderstandAnythingWebApi(context=context, runner=DummyRunner())  # type: ignore[arg-type]

        computer_use = api.status_payload()["astrbot"]["computer_use"]

        assert computer_use["runtime"] == runtime
        assert computer_use["enabled"] is enabled
        assert computer_use["require_admin"] is False
        assert computer_use["sandbox_booter"] == "shipyard_neo"
        if blocking_reason:
            assert blocking_reason in computer_use["blocking_reason"].lower()
        else:
            assert computer_use["blocking_reason"] == ""


def test_web_api_status_reports_all_astrbot_computer_use_configs(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    default_config = _DummyConfig(
        {"provider_settings": {"computer_use_runtime": "none"}},
    )
    chat_config = _DummyConfig(
        {
            "provider_settings": {
                "computer_use_runtime": "local",
                "computer_use_require_admin": False,
            },
        },
    )
    context = _RegistryContext(
        default_config,
        config_by_umo={"platform:friend:chat": chat_config},
    )
    context.astrbot_config_mgr = _DummyAstrBotConfigManager(
        {
            "default": default_config,
            "chat-config": chat_config,
        },
        [
            {"id": "chat-config", "name": "Chat config", "path": "abconf_chat.json"},
            {"id": "default", "name": "default", "path": "cmd_config.json"},
        ],
        umo_mapping={
            "platform:friend:chat": {
                "id": "chat-config",
                "name": "Chat config",
                "path": "abconf_chat.json",
            },
        },
    )
    api = UnderstandAnythingWebApi(context=context, runner=DummyRunner())  # type: ignore[arg-type]

    computer_use = api.status_payload()["astrbot"]["computer_use"]

    assert computer_use["runtime"] == "none"
    assert computer_use["enabled"] is False
    assert computer_use["dashboard_effective_config_id"] == "default"
    assert computer_use["enabled_count"] == 1
    assert computer_use["disabled_count"] == 1
    assert computer_use["all_enabled"] is False
    assert computer_use["default_config"]["id"] == "default"
    configs_by_id = {item["id"]: item for item in computer_use["configs"]}
    assert configs_by_id["default"]["enabled"] is False
    assert configs_by_id["default"]["is_default"] is True
    assert configs_by_id["chat-config"]["enabled"] is True
    assert configs_by_id["chat-config"]["runtime"] == "local"


def test_web_api_status_keeps_dashboard_available_when_only_session_config_disabled(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    default_config = _DummyConfig(
        {"provider_settings": {"computer_use_runtime": "sandbox"}},
    )
    disabled_config = _DummyConfig(
        {"provider_settings": {"computer_use_runtime": "none"}},
    )
    context = _RegistryContext(default_config)
    context.astrbot_config_mgr = _DummyAstrBotConfigManager(
        {
            "default": default_config,
            "disabled-config": disabled_config,
        },
        [
            {"id": "disabled-config", "name": "Disabled config", "path": "abconf.json"},
            {"id": "default", "name": "default", "path": "cmd_config.json"},
        ],
    )
    api = UnderstandAnythingWebApi(context=context, runner=DummyRunner())  # type: ignore[arg-type]

    computer_use = api.status_payload()["astrbot"]["computer_use"]

    assert computer_use["enabled"] is True
    assert computer_use["default_config"]["runtime"] == "sandbox"
    assert computer_use["enabled_count"] == 1
    assert computer_use["disabled_count"] == 1
    configs_by_id = {item["id"]: item for item in computer_use["configs"]}
    assert configs_by_id["disabled-config"]["enabled"] is False


@pytest.mark.asyncio
async def test_runner_fails_before_tool_loop_when_computer_use_disabled(
    tmp_path: Path,
) -> None:
    class DummyDispatcher:
        called = False

        async def run_with_local_tools(self, **_kwargs):
            self.called = True
            return "should not run"

    project_root = tmp_path / "project"
    project_root.mkdir()
    context = _RegistryContext(
        _DummyConfig(
            {
                "provider_settings": {
                    "computer_use_runtime": "none",
                    "computer_use_require_admin": True,
                }
            }
        )
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    dispatcher = DummyDispatcher()
    runner.dispatcher = dispatcher  # type: ignore[assignment]
    job = runner.jobs.create(
        "understand-diff",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "graph_root": str(project_root / ".understand-anything"),
            "source": {"type": "local"},
        },
    )

    await runner._run_skill_job(job, event=None)

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FAILED
    assert "Computer Use runtime is disabled" in (snapshot.error or "")
    assert dispatcher.called is False


@pytest.mark.asyncio
async def test_runner_uses_event_session_config_for_computer_use_check(
    tmp_path: Path,
) -> None:
    class DummyDispatcher:
        called = False
        event_umo = ""

        async def run_with_local_tools(self, **kwargs):
            self.called = True
            self.event_umo = kwargs["event"].unified_msg_origin
            return "analysis complete"

    class DummyRuntime:
        async def ensure_ready(self):
            return None

    project_root = tmp_path / "project"
    project_root.mkdir()
    default_config = _DummyConfig(
        {"provider_settings": {"computer_use_runtime": "none"}},
    )
    session_config = _DummyConfig(
        {"provider_settings": {"computer_use_runtime": "local"}},
    )
    context = _RegistryContext(
        default_config,
        config_by_umo={"parent-origin": session_config},
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    dispatcher = DummyDispatcher()
    runner.dispatcher = dispatcher  # type: ignore[assignment]
    runner.runtime = DummyRuntime()  # type: ignore[assignment]
    job = runner.jobs.create(
        "understand-diff",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "graph_root": str(project_root / ".understand-anything"),
            "source": {"type": "local"},
        },
    )

    await runner._run_skill_job(job, event=_dummy_event())

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert dispatcher.called is True
    assert dispatcher.event_umo == "parent-origin"


@pytest.mark.asyncio
async def test_web_api_subagent_provider_options_are_sanitized(tmp_path: Path) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    provider = _DummyProvider("chat-provider", model="gpt-4o")
    context = _RegistryContext(_DummyConfig(), providers=[provider])
    api = UnderstandAnythingWebApi(context=context, runner=DummyRunner())  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/subagents/providers",
        method="GET",
    ):
        response = await api.subagent_providers()

    payload = await response.get_json()
    providers = payload["data"]["providers"]
    assert payload["status"] == "ok"
    assert payload["data"]["recommended_provider_id"] == "chat-provider"
    assert providers == [
        {
            "id": "chat-provider",
            "model": "gpt-4o",
            "type": "openai",
            "provider_type": "chat_completion",
            "enable": True,
            "model_metadata": {},
        }
    ]
    assert "secret-key" not in json.dumps(payload, ensure_ascii=False)

    status_payload = api.status_payload()
    assert (
        status_payload["subagent_provider_options"]["providers"][0]["id"]
        == "chat-provider"
    )
    assert "secret-key" not in json.dumps(status_payload, ensure_ascii=False)


def test_conf_schema_exposes_subagent_parallelism_controls() -> None:
    schema = json.loads((PLUGIN_ROOT / "_conf_schema.json").read_text(encoding="utf-8"))

    assert schema["max_parallel_file_agents"]["default"] == 5
    assert schema["max_parallel_article_agents"]["default"] == 3
    assert schema["subagent_provider_id"]["_special"] == "select_provider"
    assert schema["cleanup_github_cache_after_analysis"]["default"] is False


def test_plugin_i18n_covers_config_page_and_dashboard_ui() -> None:
    schema = json.loads((PLUGIN_ROOT / "_conf_schema.json").read_text(encoding="utf-8"))
    i18n_dir = PLUGIN_ROOT / ".astrbot-plugin" / "i18n"
    locales = ["zh-CN", "en-US", "ru-RU"]

    def assert_nested_keys(value: object) -> None:
        if not isinstance(value, dict):
            return
        for key, child in value.items():
            assert "." not in key
            assert_nested_keys(child)

    for locale in locales:
        payload = json.loads((i18n_dir / f"{locale}.json").read_text(encoding="utf-8"))
        assert_nested_keys(payload)
        assert payload["metadata"]["display_name"] == "Understand Anything"
        assert payload["pages"]["dashboard"]["title"] == "Understand Anything"
        assert payload["pages"]["dashboard"]["description"]

        config = payload["config"]
        for key, field in schema.items():
            if not isinstance(field, dict):
                continue
            assert config[key]["description"]
            assert config[key]["hint"]
            if "labels" in field:
                assert len(config[key]["labels"]) == len(field["labels"])

        ui = payload["pages"]["dashboard"]["ui"]
        assert ui["common"]["refresh"]
        assert ui["workspace"]["analyzeProject"]
        assert ui["subagents"]["registerButton"]
        assert ui["search"]["placeholder"]
        assert ui["tokenGate"]["requiredTitle"]


def test_skill_prompts_require_internal_subagent_tools() -> None:
    understand = (PLUGIN_ROOT / "skills" / "understand" / "SKILL.md").read_text(
        encoding="utf-8",
    )
    knowledge = (
        PLUGIN_ROOT / "skills" / "understand-knowledge" / "SKILL.md"
    ).read_text(encoding="utf-8")
    domain = (PLUGIN_ROOT / "skills" / "understand-domain" / "SKILL.md").read_text(
        encoding="utf-8",
    )

    assert "ua_run_subagent_batches" in understand
    assert "ua_run_subagent_role" in understand
    assert "ua_run_subagent_batches" in knowledge
    assert "ua_run_subagent_role" in domain
    assert "Run an AstrBot agent role" not in understand
    assert "Run an AstrBot agent role" not in knowledge
    assert "Run an AstrBot agent role" not in domain
    assert "UA_GRAPH_ROOT" in understand
    assert "UA_GRAPH_ROOT" in domain
    assert "$PROJECT_ROOT/.understand-anything/intermediate" not in understand
    assert "$PROJECT_ROOT/.understand-anything/intermediate" not in domain


class _NoToolManager:
    def get_builtin_tool(self, tool_cls):
        return None


class _DummyProvider:
    def __init__(
        self,
        provider_id: str,
        *,
        model: str = "gpt-4o",
        provider_type: str = "openai",
        enabled: bool = True,
    ) -> None:
        self.provider_config = {
            "id": provider_id,
            "model": model,
            "type": provider_type,
            "provider_type": "chat_completion",
            "enable": enabled,
            "key": ["secret-key"],
        }

    def get_model(self) -> str:
        return str(self.provider_config["model"])

    def meta(self):
        return SimpleNamespace(
            id=self.provider_config["id"],
            model=self.provider_config["model"],
            type=self.provider_config["type"],
            provider_type=SimpleNamespace(value="chat_completion"),
        )


class _DummyProviderManager:
    def __init__(self, providers: list[_DummyProvider] | None = None) -> None:
        self.provider_insts = providers or []
        self.inst_map = {
            str(provider.provider_config["id"]): provider
            for provider in self.provider_insts
        }
        self.providers_config = [
            dict(provider.provider_config) for provider in self.provider_insts
        ]
        self.provider_sources_config: list[dict[str, object]] = []

    def get_merged_provider_config(self, provider_config: dict) -> dict:
        return dict(provider_config)


class _DummySubAgentOrchestrator:
    def __init__(self, handoff_names: list[str] | None = None) -> None:
        self.handoffs = [
            SimpleNamespace(name=name)
            for name in (handoff_names if handoff_names is not None else [])
        ]
        self.reloaded_config = None

    async def reload_from_config(self, data):
        self.reloaded_config = data
        self.handoffs = [
            SimpleNamespace(name=f"transfer_to_{item['name']}")
            for item in data.get("agents", [])
            if isinstance(item, dict) and item.get("enabled", True)
        ]


class _DummyPersonaManager:
    def __init__(self) -> None:
        self.personas: dict[str, dict[str, object]] = {}
        self.folders: dict[str, dict[str, object]] = {}
        self._folder_seq = 0

    def get_persona_v3_by_id(self, persona_id: str | None):
        if not persona_id:
            return None
        return self.personas.get(persona_id)

    async def get_folders(self, parent_id: str | None = None):
        return [
            folder
            for folder in self.folders.values()
            if folder["parent_id"] == parent_id
        ]

    async def create_folder(
        self,
        *,
        name: str,
        parent_id: str | None = None,
        description: str | None = None,
        sort_order: int = 0,
    ):
        self._folder_seq += 1
        folder = {
            "folder_id": f"folder-{self._folder_seq}",
            "name": name,
            "parent_id": parent_id,
            "description": description,
            "sort_order": sort_order,
        }
        self.folders[str(folder["folder_id"])] = folder
        return folder

    async def create_persona(
        self,
        *,
        persona_id: str,
        system_prompt: str,
        begin_dialogs=None,
        tools=None,
        skills=None,
        custom_error_message=None,
        folder_id=None,
        sort_order=0,
        **_kwargs,
    ):
        if persona_id in self.personas:
            raise ValueError(f"Persona with ID {persona_id} already exists.")
        persona = {
            "persona_id": persona_id,
            "name": persona_id,
            "prompt": system_prompt,
            "begin_dialogs": begin_dialogs or [],
            "tools": tools,
            "skills": skills,
            "custom_error_message": custom_error_message,
            "folder_id": folder_id,
            "sort_order": sort_order,
        }
        self.personas[persona_id] = persona
        return persona

    async def update_persona(
        self,
        *,
        persona_id: str,
        system_prompt: str | None = None,
        begin_dialogs=None,
        tools=None,
        skills=None,
        custom_error_message=None,
        **_kwargs,
    ):
        persona = self.personas[persona_id]
        if system_prompt is not None:
            persona["prompt"] = system_prompt
        persona["begin_dialogs"] = begin_dialogs or []
        persona["tools"] = tools
        persona["skills"] = skills
        persona["custom_error_message"] = custom_error_message
        return persona

    async def move_persona_to_folder(self, persona_id: str, folder_id: str | None):
        persona = self.personas[persona_id]
        persona["folder_id"] = folder_id
        return persona


def _ua_handoff_names(roles=ROLE_NAMES) -> list[str]:
    return [
        f"transfer_to_{UnderstandAnythingSubAgentRegistry.agent_name_for_role(role)}"
        for role in roles
    ]


class _DummyContext:
    def __init__(
        self,
        handoff_names: list[str] | None = None,
        providers: list[_DummyProvider] | None = None,
    ) -> None:
        self.persona_manager = _DummyPersonaManager()
        self.subagent_orchestrator = _DummySubAgentOrchestrator(
            handoff_names if handoff_names is not None else _ua_handoff_names(),
        )
        self.provider_manager = _DummyProviderManager(providers)

    def get_llm_tool_manager(self):
        return _NoToolManager()

    def get_provider_by_id(self, provider_id: str):
        return self.provider_manager.inst_map.get(provider_id)

    def get_all_providers(self):
        return self.provider_manager.provider_insts

    def get_using_provider(self, umo=None):
        return (
            self.provider_manager.provider_insts[0]
            if self.provider_manager.provider_insts
            else None
        )


class _DummyConfig(dict):
    saved = False

    def save_config(self, replace_config=None):
        if isinstance(replace_config, dict):
            self.update(replace_config)
        self.saved = True


class _DummyAstrBotConfigManager:
    def __init__(
        self,
        confs: dict[str, _DummyConfig],
        conf_list: list[dict[str, str]],
        umo_mapping: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self.confs = confs
        self._conf_list = conf_list
        self._umo_mapping = umo_mapping or {}

    def get_conf_list(self):
        return list(self._conf_list)

    def get_conf_info(self, umo):
        return self._umo_mapping.get(
            umo,
            {"id": "default", "name": "default", "path": "cmd_config.json"},
        )

    def get_conf(self, umo=None):
        info = self.get_conf_info(umo) if umo else {"id": "default"}
        return self.confs.get(info["id"], self.confs["default"])


class _RegistryContext(_DummyContext):
    def __init__(
        self,
        config: _DummyConfig,
        providers: list[_DummyProvider] | None = None,
        config_by_umo: dict[str, _DummyConfig] | None = None,
    ) -> None:
        super().__init__(handoff_names=[], providers=providers)
        self.config = config
        self.config_by_umo = config_by_umo or {}

    def get_config(self, umo=None):
        if umo in self.config_by_umo:
            return self.config_by_umo[umo]
        return self.config


def _dummy_event():
    async def send(_message):
        return None

    return SimpleNamespace(
        session_id="parent-session",
        role="admin",
        unified_msg_origin="parent-origin",
        send=send,
    )


def test_subagent_registry_registers_from_empty_orchestrator() -> None:
    config = _DummyConfig()
    context = _RegistryContext(config)
    registry = UnderstandAnythingSubAgentRegistry(context, {})

    payload = asyncio.run(registry.register_required_subagents())

    agents = config["subagent_orchestrator"]["agents"]
    assert config.saved is True
    assert payload["ready"] is True
    assert payload["persona_upserted_count"] == len(ROLE_NAMES)
    assert payload["persona_folder_id"] == "folder-1"
    assert len(agents) == len(ROLE_NAMES)
    assert config["subagent_orchestrator"]["metadata"] == {
        "ua_persona_folder_name": UA_PERSONA_FOLDER_NAME,
        "ua_persona_folder_id": "folder-1",
    }
    assert {agent["name"] for agent in agents} == {
        UnderstandAnythingSubAgentRegistry.agent_name_for_role(role)
        for role in ROLE_NAMES
    }
    assert all(agent["persona_id"] == agent["name"] for agent in agents)
    assert all(agent["tools"] == list(UA_AGENT_TOOLS) for agent in agents)
    assert all(agent["provider_id"] is None for agent in agents)
    assert set(context.persona_manager.personas) == {
        UnderstandAnythingSubAgentRegistry.agent_name_for_role(role)
        for role in ROLE_NAMES
    }
    assert context.persona_manager.folders == {
        "folder-1": {
            "folder_id": "folder-1",
            "name": UA_PERSONA_FOLDER_NAME,
            "parent_id": None,
            "description": (
                "Personas managed by the Understand Anything plugin for UA SubAgents."
            ),
            "sort_order": 0,
        }
    }
    assert all(
        persona["tools"] == list(UA_AGENT_TOOLS)
        for persona in context.persona_manager.personas.values()
    )
    assert all(
        persona["skills"]
        == list(
            UA_ROLE_SKILLS[persona["persona_id"].removeprefix("ua_").replace("_", "-")]
        )
        for persona in context.persona_manager.personas.values()
    )
    assert all(
        persona["folder_id"] == "folder-1"
        for persona in context.persona_manager.personas.values()
    )


def test_subagent_registry_preserves_non_ua_agents_and_hides_provider() -> None:
    config = _DummyConfig(
        {
            "subagent_orchestrator": {
                "main_enable": True,
                "remove_main_duplicate_tools": True,
                "agents": [{"name": "custom_agent", "enabled": True}],
            }
        }
    )
    context = _RegistryContext(config)
    registry = UnderstandAnythingSubAgentRegistry(
        context,
        {
            "provider_id": "secret-provider-id",
            "subagent_provider_id": "secret-subagent-provider-id",
        },
    )

    payload = asyncio.run(registry.register_required_subagents())

    data = config["subagent_orchestrator"]
    agents = data["agents"]
    assert data["main_enable"] is True
    assert data["remove_main_duplicate_tools"] is True
    assert agents[0]["name"] == "custom_agent"
    assert len(agents) == len(ROLE_NAMES) + 1
    assert all(agent["persona_id"] == agent["name"] for agent in agents[1:])
    assert all(
        agent["provider_id"] == "secret-subagent-provider-id" for agent in agents[1:]
    )
    assert len(context.persona_manager.folders) == 1
    assert all(
        persona["folder_id"] == data["metadata"]["ua_persona_folder_id"]
        for persona in context.persona_manager.personas.values()
    )
    assert payload["ready"] is True
    assert "secret-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert "secret-subagent-provider-id" not in json.dumps(payload, ensure_ascii=False)


def test_subagent_registry_uses_selected_provider_without_response_leak() -> None:
    config = _DummyConfig()
    context = _RegistryContext(
        config,
        providers=[_DummyProvider("selected-provider", model="claude-sonnet-4-5")],
    )
    registry = UnderstandAnythingSubAgentRegistry(
        context,
        {
            "provider_id": "plugin-provider",
            "subagent_provider_id": "plugin-subagent-provider",
        },
    )

    payload = asyncio.run(
        registry.register_required_subagents(
            provider_id="selected-provider",
            provider_id_provided=True,
        )
    )

    data = config["subagent_orchestrator"]
    agents = data["agents"]
    assert data["metadata"]["ua_provider_id"] == "selected-provider"
    assert data["metadata"]["ua_provider_selected"] is True
    assert all(agent["provider_id"] == "selected-provider" for agent in agents)
    assert payload["ready"] is True
    assert "selected-provider" not in json.dumps(payload, ensure_ascii=False)
    assert "plugin-provider" not in json.dumps(payload, ensure_ascii=False)
    assert "plugin-subagent-provider" not in json.dumps(payload, ensure_ascii=False)


def test_subagent_registry_rejects_unavailable_selected_provider() -> None:
    config = _DummyConfig()
    context = _RegistryContext(config, providers=[_DummyProvider("available")])
    registry = UnderstandAnythingSubAgentRegistry(context, {})

    with pytest.raises(ValueError, match="Provider missing-provider is not available"):
        asyncio.run(
            registry.register_required_subagents(
                provider_id="missing-provider",
                provider_id_provided=True,
            )
        )


def test_subagent_registry_detects_stale_and_upserts_without_duplicates() -> None:
    config = _DummyConfig()
    context = _RegistryContext(config)
    registry = UnderstandAnythingSubAgentRegistry(context, {})
    asyncio.run(registry.register_required_subagents())
    first_agent = config["subagent_orchestrator"]["agents"][0]
    first_agent["system_prompt"] = "outdated prompt"
    first_persona_id = first_agent["persona_id"]
    context.persona_manager.personas[first_persona_id]["tools"] = []
    context.persona_manager.personas[first_persona_id]["skills"] = []
    context.persona_manager.personas[first_persona_id]["folder_id"] = None

    stale_payload = registry.status_payload()

    assert stale_payload["ready"] is False
    assert first_agent["metadata"]["ua_role"] in stale_payload["stale_roles"]
    first_role = next(
        item
        for item in stale_payload["roles"]
        if item["agent_name"] == first_agent["name"]
    )
    assert "prompt" in first_role["stale_reasons"]
    assert "persona_tools" in first_role["stale_reasons"]
    assert "persona_skills" in first_role["stale_reasons"]
    assert "persona_folder" in first_role["stale_reasons"]

    payload = asyncio.run(registry.register_required_subagents())
    agents = config["subagent_orchestrator"]["agents"]

    assert payload["ready"] is True
    assert len(agents) == len(ROLE_NAMES)
    assert len({agent["name"] for agent in agents}) == len(ROLE_NAMES)
    assert agents[0]["system_prompt"] != "outdated prompt"
    assert context.persona_manager.personas[first_persona_id]["tools"] == list(
        UA_AGENT_TOOLS
    )
    assert context.persona_manager.personas[first_persona_id]["skills"] == list(
        UA_ROLE_SKILLS[first_agent["metadata"]["ua_role"]]
    )
    assert (
        context.persona_manager.personas[first_persona_id]["folder_id"]
        == config["subagent_orchestrator"]["metadata"]["ua_persona_folder_id"]
    )


def test_dispatcher_reports_missing_persisted_subagent_role() -> None:
    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(handoff_names=[]),  # type: ignore[arg-type]
        handoff_executor=lambda *_args: None,  # type: ignore[arg-type]
    )

    result = asyncio.run(
        dispatcher.run_role(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            input_text="analyze this batch",
        )
    )

    assert result["status"] == "failed"
    assert "not registered or loaded" in result["error"]


def test_subagent_batches_respect_max_concurrency() -> None:
    active = 0
    max_seen = 0

    async def fake_handoff(_handoff, _run_context, tool_args):
        nonlocal active, max_seen
        assert _handoff.name == "transfer_to_ua_file_analyzer"
        active += 1
        max_seen = max(max_seen, active)
        await asyncio.sleep(0.02)
        active -= 1
        return f"done:{tool_args['input']}"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            batches=[
                {"id": "0", "input": "batch 0"},
                {"id": "1", "input": "batch 1"},
                {"id": "2", "input": "batch 2"},
                {"id": "3", "input": "batch 3"},
            ],
            max_concurrency=2,
        )
    )

    assert result["status"] == "ok"
    assert max_seen == 2
    assert len(result["results"]) == 4
    assert all(item["role"] == "file-analyzer" for item in result["results"])


def test_subagent_batches_continue_after_batch_failure() -> None:
    async def fake_handoff(_handoff, _run_context, tool_args):
        if "fail" in tool_args["input"]:
            raise RuntimeError("planned failure")
        return "ok"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="article-analyzer",
            batches=[
                {"id": "0", "input": "ok 0"},
                {"id": "1", "input": "fail 1"},
                {"id": "2", "input": "ok 2"},
            ],
            max_concurrency=3,
            continue_on_error=True,
        )
    )

    assert result["status"] == "failed"
    assert [item["status"] for item in result["results"]].count("failed") == 1
    assert len(result["results"]) == 3


def test_mock_subagent_batches_feed_existing_merge_script(tmp_path: Path) -> None:
    project_root = tmp_path / "fixture-project"
    project_root.mkdir()
    graph_root = tmp_path / "artifacts" / ".understand-anything"
    intermediate = graph_root / "intermediate"
    intermediate.mkdir(parents=True)

    async def fake_handoff(_handoff, _run_context, tool_args):
        output_path = Path(tool_args["input"])
        batch_index = output_path.stem.split("-")[-1]
        source_path = f"src/file{batch_index}.py"
        output_path.write_text(
            json.dumps(
                {
                    "nodes": [
                        {
                            "id": f"file:{source_path}",
                            "type": "file",
                            "name": output_path.stem,
                            "filePath": source_path,
                            "summary": "Generated by mock SubAgent",
                            "tags": [],
                            "complexity": "low",
                        }
                    ],
                    "edges": [],
                }
            ),
            encoding="utf-8",
        )
        return f"wrote {output_path.name}"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )
    batches = [
        {
            "id": str(index),
            "input": str(intermediate / f"batch-{index}.json"),
            "expected_output_path": str(intermediate / f"batch-{index}.json"),
        }
        for index in range(2)
    ]

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            batches=batches,
            max_concurrency=2,
        )
    )

    assert result["status"] == "ok"
    assert all(item["output"]["exists"] for item in result["results"])

    proc = subprocess.run(
        [
            sys.executable,
            str(PLUGIN_ROOT / "skills" / "understand" / "merge-batch-graphs.py"),
            str(project_root),
            str(graph_root),
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    assert proc.returncode == 0, proc.stderr
    assembled = json.loads(
        (intermediate / "assembled-graph.json").read_text(encoding="utf-8")
    )
    assert len(assembled["nodes"]) == 2
    assert {node["complexity"] for node in assembled["nodes"]} == {"simple"}


def test_subagent_batches_stop_when_continue_on_error_is_false() -> None:
    async def fake_handoff(_handoff, _run_context, tool_args):
        if "fail" in tool_args["input"]:
            raise RuntimeError("planned failure")
        await asyncio.sleep(0.05)
        return "ok"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    with pytest.raises(RuntimeError, match="SubAgent batch failed"):
        asyncio.run(
            dispatcher.run_batches(
                _dummy_event(),  # type: ignore[arg-type]
                role="file-analyzer",
                batches=[
                    {"id": "0", "input": "fail 0"},
                    {"id": "1", "input": "ok 1"},
                ],
                max_concurrency=2,
                continue_on_error=False,
            )
        )
