from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from astrbot_adapter.job_request import format_job_args, parse_job_args
from astrbot_adapter.job_store import JobStore, JobStatus
from astrbot_adapter.path_security import PathSecurityError, PathSecurity
from astrbot_adapter.project_registry import ProjectRegistry, ProjectRegistryError
from astrbot_adapter.project_store import ProjectStore
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

    with pytest.raises(PermissionError):
        store.read_source_file("pyproject.toml")


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


def test_web_api_status_summarizes_config_without_provider_secret(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config = {
            "provider_id": "secret-provider-id",
            "node_bin": "node-custom",
            "pnpm_bin": "pnpm-custom",
            "auto_build": False,
            "auto_update_poll_interval": 30,
            "max_concurrent_jobs": 2,
            "default_write_mode": "project",
        }
        security = PathSecurity([tmp_path])

    api = UnderstandAnythingWebApi(context=None, runner=DummyRunner())  # type: ignore[arg-type]
    routes = {route for route, *_ in api.routes()}
    payload = api.status_payload()

    assert "/astrbot_plugin_UnderstandAnything/status" in routes
    assert payload["plugin"]["name"] == "astrbot_plugin_UnderstandAnything"
    assert payload["config"]["provider_configured"] is True
    assert payload["config"]["node_bin"] == "node-custom"
    assert payload["config"]["allowed_roots"] == [str(tmp_path.resolve())]
    assert "provider_id" not in payload["config"]
    assert "secret-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert payload["runtime"]["dashboard_page"]["exists"] is True
