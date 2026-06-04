# ruff: noqa: E402

from __future__ import annotations

import asyncio
import importlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from quart import Quart, g

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))
ASTRBOT_ROOT = PLUGIN_ROOT.parent / "AstrBot"
if ASTRBOT_ROOT.exists():
    sys.path.insert(0, str(ASTRBOT_ROOT))

from astrbot_adapter.github_repo import (
    GitCommandResult,
    GitHubRepoError,
    GitHubRepoManager,
)
from astrbot_adapter.ignore_review import (
    append_ignore_patterns,
    build_ignore_confirmation,
)
from astrbot_adapter.job_request import format_job_args, parse_job_args
from astrbot_adapter.job_store import JobStatus, JobStore
from astrbot_adapter.path_security import PathSecurity, PathSecurityError
from astrbot_adapter.project_registry import (
    ProjectRegistry,
    ProjectRegistryError,
    ProjectStatus,
)
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


def _sample_fingerprints(commit: str = "abc") -> dict[str, object]:
    return {
        "version": "1.0.0",
        "gitCommitHash": commit,
        "generatedAt": "2026-03-14T00:00:00.000Z",
        "files": {
            "src/index.ts": {
                "filePath": "src/index.ts",
                "contentHash": "deadbeef",
                "functions": [],
                "classes": [],
                "imports": [],
                "exports": [],
                "totalLines": 1,
                "hasStructuralAnalysis": False,
            }
        },
    }


def _write_validation_sidecars(graph_root: Path) -> None:
    (graph_root / "source-inventory.json").write_text(
        json.dumps({}),
        encoding="utf-8",
    )
    (graph_root / "quality-report.json").write_text(
        json.dumps({}),
        encoding="utf-8",
    )


def test_plugin_main_uses_package_relative_adapter_imports() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert "from astrbot_adapter" not in source
    assert "from .astrbot_adapter" in source


def test_main_plugin_exposes_single_natural_understand_command() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert '@filter.command("understand")' in source
    assert '@filter.command_group("understand")' not in source
    assert '@filter.command("understand-' not in source
    assert 'alias={"understand_' not in source
    assert 'self._args(event, "understand-' not in source
    assert "UNDERSTAND_GROUP_SUBCOMMANDS" not in source
    assert "_is_understand_group_subcommand" not in source
    for legacy in (
        "analyze",
        "status",
        "dashboard",
        "chat",
        "diff",
        "domain",
        "explain",
        "knowledge",
        "onboard",
    ):
        old_decorator = "@understand_commands" + f'.command("{legacy}")'
        assert old_decorator not in source


def test_main_plugin_llm_tools_are_structured_and_not_legacy() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert '@filter.llm_tool(name="ua_get_project_state")' in source
    assert '@filter.llm_tool(name="ua_project_action")' in source
    assert '@filter.llm_tool(name="ua_retrieve_project_context")' in source
    for suffix in (
        "start_project_analysis",
        "start_github_analysis",
        "get_analysis_status",
        "ask_graph",
        "explain_component",
        "analyze_diff",
        "generate_onboarding",
        "open_dashboard",
    ):
        legacy_tool = "ua_" + suffix
        assert f'@filter.llm_tool(name="{legacy_tool}")' not in source
    assert '@filter.llm_tool(name="ua_analyze_project")' not in source
    assert '@filter.llm_tool(name="ua_analyze_github_repo")' not in source
    assert '@filter.llm_tool(name="ua_search_graph")' not in source
    assert '@filter.llm_tool(name="ua_chat_with_graph")' not in source
    old_scope_text = "confirm scan " + "scope before graph generation"
    assert old_scope_text not in source
    assert "reply with exactly the returned message" not in source
    old_tool_message_call = "format_tool_job_" + "submitted_message(job)"
    assert old_tool_message_call not in source
    assert "return self.runner.format_job_started_message(job)" not in source
    assert "job_id(string)" not in source


def test_main_plugin_tools_do_not_generate_final_answers_directly() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")
    tool_source = source[
        source.index('@filter.llm_tool(name="ua_get_project_state")') :
    ]

    assert "return await self.runner.chat(" not in tool_source
    assert "return await self.runner.explain(" not in tool_source
    assert "return await self.runner.diff(" not in tool_source
    assert "return await self.runner.onboard(" not in tool_source


def test_main_natural_command_uses_chat_entry_executor() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert "self.chat_entry" in source
    assert "execute_text(" in source


def test_main_plugin_webchat_project_kwargs_include_stored_context_items(
    tmp_path: Path,
) -> None:
    from astrbot_adapter.webchat_proxy import WebChatSessionContextStore

    sys.path.insert(0, str(PLUGIN_ROOT.parent))
    plugin_module = importlib.import_module(f"{PLUGIN_ROOT.name}.main")
    plugin = plugin_module.UnderstandAnythingPlugin.__new__(
        plugin_module.UnderstandAnythingPlugin,
    )
    plugin.webchat_context_store = WebChatSessionContextStore(
        tmp_path / "contexts.json"
    )
    plugin.webchat_context_store.update(
        session_id="s1",
        username="alice",
        project_ref={"project_id": "p1", "project_name": "Demo"},
        context_items=[{"type": "node", "nodeId": "root"}],
    )
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:webchat!alice!s1",
    )

    assert plugin._effective_project_kwargs(event) == {
        "project_id": "p1",
        "project_name": "Demo",
        "context_items": [{"type": "node", "nodeId": "root"}],
    }


def test_web_api_webchat_sse_disables_response_timeout() -> None:
    source = (PLUGIN_ROOT / "astrbot_adapter" / "web_api.py").read_text(
        encoding="utf-8",
    )
    webchat_sse_source = source[
        source.index("    async def webchat_send_events(self):") : source.index(
            "    async def stop_webchat_session(self):",
        )
    ]

    assert "response.timeout = None" in webchat_sse_source


def test_dashboard_page_bundle_is_plugin_page_safe() -> None:
    source_html = (
        PLUGIN_ROOT / "understand-anything" / "packages" / "dashboard" / "index.html"
    ).read_text(encoding="utf-8")
    dist_html = (
        PLUGIN_ROOT
        / "understand-anything"
        / "packages"
        / "dashboard"
        / "dist"
        / "index.html"
    ).read_text(encoding="utf-8")
    page_html = (PLUGIN_ROOT / "pages" / "dashboard" / "index.html").read_text(
        encoding="utf-8",
    )
    page_assets_dir = PLUGIN_ROOT / "pages" / "dashboard" / "assets"
    js_assets = list(page_assets_dir.glob("*.js"))
    bridge_loader = (
        PLUGIN_ROOT
        / "understand-anything"
        / "packages"
        / "dashboard"
        / "src"
        / "utils"
        / "pluginPageContext.ts"
    ).read_text(encoding="utf-8")

    app_index = source_html.index("/src/main.tsx")
    page_app_index = page_html.index('src="./assets/index-')
    assert app_index >= 0
    assert page_app_index >= 0
    assert "document.write" not in source_html
    assert "document.write" not in dist_html
    assert "document.write" not in page_html
    assert "/api/plugin/page/bridge-sdk.js" not in source_html
    assert "/api/plugin/page/bridge-sdk.js" not in page_html
    assert "bridge-sdk.js" in bridge_loader
    assert '["", "api", "plugin", "page", "bridge-sdk.js"]' in bridge_loader
    assert "i18n_scope" in bridge_loader
    assert '"page"' in bridge_loader
    assert "asset_token" in bridge_loader
    for built_html in (dist_html, page_html):
        # AstrBot embeds plugin pages in a sandboxed iframe without allow-same-origin.
        # ES module scripts loaded from that opaque origin require CORS headers on
        # every chunk, so the committed plugin page must use classic scripts.
        assert 'type="module"' not in built_html
        assert 'rel="modulepreload"' not in built_html
        assert 'crossorigin src="./assets/' not in built_html
        assert 'src="./assets/index-' in built_html
    assert len(js_assets) >= 1
    assert any(asset.name.startswith("index-") for asset in js_assets)
    assert not list((PLUGIN_ROOT / "pages" / "dashboard").rglob("*.map"))
    for asset in js_assets:
        assert page_assets_dir in asset.parents
        content = asset.read_text(encoding="utf-8", errors="ignore")
        assert "D:/AboutDEV" not in content
        assert "D:\\AboutDEV" not in content
        assert "file://" not in content


def test_assistant_dist_is_distributable() -> None:
    expected_files = [
        PLUGIN_ROOT / "understand-anything" / "packages" / "assistant" / "dist" / name
        for name in ("index.js", "index.d.ts", "index.d.ts.map")
    ]

    for file_path in expected_files:
        assert file_path.is_file(), f"Missing bundled assistant dist: {file_path}"
        check = subprocess.run(
            ["git", "check-ignore", "-q", str(file_path.relative_to(PLUGIN_ROOT))],
            cwd=PLUGIN_ROOT,
            check=False,
        )
        assert check.returncode == 1, f"Assistant dist is ignored: {file_path}"


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
    jobs.set_progress(job.job_id, "agent", "Running workflow.", 55)
    jobs.mark_running(job.job_id)
    jobs.mark_finished(job.job_id, {"graph": "knowledge-graph.json"})

    snapshot = jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert snapshot.logs == ["started"]
    assert snapshot.result == {"graph": "knowledge-graph.json"}
    assert snapshot.progress.phase == "complete"
    assert snapshot.to_dict()["progress"]["percent"] == 100


def test_job_store_tracks_structured_progress_and_cancellation() -> None:
    jobs = JobStore()

    job = jobs.create("understand", Path("D:/project"), {"project_id": "p1"})
    assert job.progress.phase == "queued"
    assert job.progress.steps[0]["status"] == "active"

    jobs.set_progress(job.job_id, "runtime", "Preparing runtime.", 30)
    snapshot = jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.progress.phase == "runtime"
    assert snapshot.progress.steps[0]["status"] == "complete"
    assert snapshot.progress.steps[3]["status"] == "active"

    jobs.mark_cancelled(job.job_id)
    snapshot = jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.CANCELLED
    assert snapshot.progress.phase == "cancelled"


def test_job_store_serializes_structured_observations() -> None:
    jobs = JobStore()

    job = jobs.create("understand", Path("D:/project"), {"project_id": "p1"})
    observation = jobs.append_observation(
        job.job_id,
        kind="validation",
        level="warning",
        title="产物校验",
        message="quality-report.json 有警告。",
        stage="validate",
        status="warning",
        details={"artifact": "quality-report.json", "warnings": 1},
    )

    payload = jobs.get(job.job_id).to_dict()  # type: ignore[union-attr]

    assert payload["terminal"] is False
    assert payload["observations"] == [
        {
            "id": observation.id,
            "timestamp": observation.timestamp,
            "createdAt": observation.timestamp,
            "kind": "validation",
            "level": "warning",
            "title": "产物校验",
            "message": "quality-report.json 有警告。",
            "stage": "validate",
            "status": "warning",
            "details": {"artifact": "quality-report.json", "warnings": 1},
        }
    ]

    jobs.mark_failed(job.job_id, "Invalid graph.")
    failed_payload = jobs.get(job.job_id).to_dict()  # type: ignore[union-attr]

    assert failed_payload["terminal"] is True
    assert failed_payload["observations"][-1]["kind"] == "error"
    assert failed_payload["observations"][-1]["level"] == "error"
    assert failed_payload["observations"][-1]["stage"] == "validate"
    assert failed_payload["observations"][-1]["message"] == "Invalid graph."


def test_runner_formats_compact_chat_job_status(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        tmp_path / "project",
        {
            "project_id": "project-1",
            "raw_args": "D:/repo",
            "project_display_name": "Demo",
            "status_ref": "Demo",
        },
    )
    runner.jobs.mark_running(job.job_id)
    runner.jobs.set_progress(
        job.job_id,
        "agent",
        "Running Understand Anything agent workflow.",
        55,
    )
    runner.jobs.append_log(job.job_id, "SubAgent started: file-analyzer:0")
    runner.jobs.append_log(job.job_id, "SubAgent finished: file-analyzer:0 status=ok")

    message = runner.format_job_status("Demo")

    assert "分析状态：Demo" in message
    assert "状态：运行中" in message
    assert "进度：55%" in message
    assert "生成图谱" in message
    assert job.job_id not in message
    assert "SubAgent started" not in message
    assert "SubAgent finished" not in message


def test_runner_formats_latest_active_job_when_status_id_omitted(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    finished = runner.jobs.create("understand", tmp_path / "old", {})
    runner.jobs.mark_finished(finished.job_id, {"message": "done"})
    active = runner.jobs.create("understand", tmp_path / "active", {})
    runner.jobs.mark_running(active.job_id)

    message = runner.format_job_status()

    assert "active" in message
    assert active.job_id not in message
    assert finished.job_id not in message


@pytest.mark.asyncio
async def test_runner_source_message_uses_project_status_ref_not_job_id(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstrBotDevs/AstrBot",
        start_task=False,
    )

    message = runner.format_job_source_started_message(job)

    assert "正在获取源码：AstrBot" in message
    assert "源码准备完成后将进入分析流程" in message
    old_scope_text = "确认" + "扫描范围"
    assert old_scope_text not in message
    assert "已开始分析" not in message
    assert "/understand 状态 AstrBot" in message
    assert job.job_id not in message


@pytest.mark.asyncio
async def test_runner_sends_source_notification_before_background_task(
    tmp_path: Path,
) -> None:
    events: list[str] = []

    class Context:
        async def send_message(self, _session, message):
            events.append(f"send:{message.get_plain_text()}")
            return True

    async def fake_run_skill_job(_job, _event):
        events.append("run")

    project = tmp_path / "project"
    project.mkdir()
    event = SimpleNamespace(unified_msg_origin="webchat:FriendMessage:session-1")
    runner = UnderstandAnythingRunner(
        context=Context(),  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    runner._run_skill_job = fake_run_skill_job  # type: ignore[method-assign]

    job = await runner.start_skill_job(
        skill_name="understand",
        project_path=project,
        event=event,  # type: ignore[arg-type]
    )
    await runner._tasks[job.job_id]

    assert events[0].startswith("send:正在获取源码：project")
    assert "已开始分析" not in events[0]
    assert "源码准备完成后将进入分析流程" in events[0]
    old_scope_text = "确认" + "扫描范围"
    assert old_scope_text not in events[0]
    assert events[1] == "run"
    assert job.args["started_notification_sent"] is True


@pytest.mark.asyncio
async def test_runner_source_message_is_phase_safe_after_source_notification(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstrBotDevs/AstrBot",
        start_task=False,
    )
    job.args["started_notification_sent"] = True

    message = runner.format_job_source_started_message(job)

    banned = ["提交", "后台执行", "已开始分析", "submitted", "Started analysis"]
    assert "源码准备" in message
    old_scope_text = "确认" + "扫描范围"
    assert old_scope_text not in message
    assert "确认后才开始生成图谱" not in message
    for phrase in banned:
        assert phrase not in message


@pytest.mark.asyncio
async def test_started_notification_is_deduplicated_by_key(tmp_path: Path) -> None:
    class Context:
        def __init__(self) -> None:
            self.messages: list[str] = []

        async def send_message(self, _session, message):
            self.messages.append(message.get_plain_text())
            return True

    context = Context()
    event = SimpleNamespace(unified_msg_origin="webchat:FriendMessage:session-1")
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create("understand", tmp_path / "project", {})

    first = await runner._send_job_chat_message(
        job,
        event,  # type: ignore[arg-type]
        "started once",
        key="started",
    )
    second = await runner._send_job_chat_message(
        job,
        event,  # type: ignore[arg-type]
        "started twice",
        key="started",
    )

    assert first is True
    assert second is True
    assert context.messages == ["started once"]


@pytest.mark.asyncio
async def test_runner_status_matches_running_github_job_by_project_aliases(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstrBotDevs/AstrBot",
        start_task=False,
    )

    by_repo = runner.format_job_status("AstrBot")
    by_owner_repo = runner.format_job_status("AstrBotDevs/AstrBot")

    assert "分析状态：AstrBot" in by_repo
    assert "分析状态：AstrBot" in by_owner_repo
    assert job.job_id not in by_repo
    assert job.job_id not in by_owner_repo


def test_runner_status_reports_ambiguous_project_name_without_logs(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    first = runner.jobs.create(
        "understand",
        tmp_path / "owner-a" / "demo",
        {
            "status_ref": "demo",
            "project_display_name": "demo",
            "status_aliases": ["owner-a/demo"],
        },
    )
    second = runner.jobs.create(
        "understand",
        tmp_path / "owner-b" / "demo",
        {
            "status_ref": "demo",
            "project_display_name": "demo",
            "status_aliases": ["owner-b/demo"],
        },
    )
    runner.jobs.append_log(first.job_id, "SubAgent started: file-analyzer:0")
    runner.jobs.append_log(second.job_id, "SubAgent finished: file-analyzer:0")

    message = runner.format_job_status("demo")

    assert "匹配到多个项目：demo" in message
    assert "owner-a/demo" in message
    assert "owner-b/demo" in message
    assert first.job_id not in message
    assert second.job_id not in message
    assert "SubAgent started" not in message
    assert "SubAgent finished" not in message


def test_runner_formats_github_failure_with_retry_hint(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    repo_url = "https://github.com/AstralSolipsism/demo"
    job = runner.jobs.create(
        "understand",
        tmp_path / "github-cache",
        {
            "source": {
                "type": "github",
                "target_url": repo_url,
                "repo_url": repo_url,
            },
        },
    )
    runner.jobs.mark_failed(
        job.job_id,
        "fatal: unable to access repo: Recv failure: Connection was reset",
    )
    runner.jobs.append_log(job.job_id, "SubAgent started: file-analyzer:0")

    job.args["project_display_name"] = "demo"
    job.args["status_ref"] = "demo"
    job.args["status_aliases"] = ["AstralSolipsism/demo", repo_url]

    message = runner.format_job_status("demo")

    assert "分析失败：demo" in message
    assert "原因：fatal: unable to access repo" in message
    assert "重试：" in message
    assert "已自动尝试直连 GitHub 和内置代理预设" in message
    assert "--github-proxy" not in message
    assert job.job_id not in message
    assert "SubAgent started" not in message


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

    deleted = registry.delete(updated.project_id)
    assert deleted is not None
    assert deleted.project_id == updated.project_id
    assert registry.get(project_id=updated.project_id) is None


def test_project_registry_serializes_dashboard_project_state(
    tmp_path: Path,
) -> None:
    project = tmp_path / "Project With State"
    graph_root = project / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps(
            {
                "project": {"name": "Stateful Project"},
                "nodes": [{"id": "file:src/app.py"}],
                "edges": [{"source": "a", "target": "b"}],
            }
        ),
        encoding="utf-8",
    )
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(project)

    registry.update_status(
        record.project_id,
        ProjectStatus.ANALYZING,
        current_job_id="job-1",
    )
    registry.update_status(
        record.project_id,
        ProjectStatus.READY,
        current_job_id=None,
        last_job_id="job-1",
        last_error=None,
        node_count=1,
        edge_count=1,
    )
    payload = registry.get(project_id=record.project_id).to_dict()  # type: ignore[union-attr]

    assert payload["status"] == "ready"
    assert payload["current_job_id"] is None
    assert payload["last_job_id"] == "job-1"
    assert payload["last_error"] is None
    assert payload["last_analyzed_at"] is not None
    assert payload["node_count"] == 1
    assert payload["edge_count"] == 1
    assert payload["graph_root"] == str(graph_root.resolve())
    assert payload["id"] == payload["project_id"]
    assert payload["currentJobId"] is None
    assert payload["lastAnalyzedAt"] is not None
    assert payload["nodeCount"] == 1
    assert payload["edgeCount"] == 1

    reloaded = ProjectRegistry(tmp_path / "projects.json")
    reloaded_payload = reloaded.get(project_id=record.project_id).to_dict()  # type: ignore[union-attr]

    assert reloaded_payload["status"] == "ready"
    assert reloaded_payload["node_count"] == 1
    assert reloaded_payload["edge_count"] == 1


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


def test_runner_prompt_treats_understandignore_as_non_blocking(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    graph_root = project / ".understand-anything"
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "raw_args": str(project),
            "project_path": str(project),
            "graph_root": str(graph_root),
            "locale": "zh-CN",
            "source": {"type": "local"},
        },
    )

    prompt = runner._build_skill_execution_prompt(job)

    assert "Do not pause for `.understandignore` review or confirmation" in prompt
    assert "bundled default ignore rules" in prompt
    assert "host adapter handles `.understandignore` confirmation" not in prompt
    assert "non-interactive AstrBot host run" not in prompt
    assert "Generate all user-visible textual content in Simplified Chinese" in prompt
    assert "Keep code identifiers, file paths, schema keys, tags" in prompt


def test_runner_output_locale_config_overrides_job_locale(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={"output_locale": "en-US"},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "raw_args": str(project),
            "project_path": str(project),
            "graph_root": str(project / ".understand-anything"),
            "locale": "zh-CN",
            "source": {"type": "local"},
        },
    )

    prompt = runner._build_skill_execution_prompt(job)

    assert "Generate all user-visible textual content in English" in prompt
    assert "Simplified Chinese" not in prompt


def test_runner_auto_locale_ignores_github_url_noise(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    event = SimpleNamespace(
        message_str="/understand 分析 https://github.com/AstrBotDevs/AstrBot",
    )

    assert runner._resolve_output_locale(event=event) == "zh-CN"


def test_runner_auto_locale_ignores_llm_tool_name_noise(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    event = SimpleNamespace(
        message_str=(
            "ua_" + "start_github_analysis "
            "repo_url=https://github.com/AstrBotDevs/AstrBot"
        ),
    )

    assert runner._resolve_output_locale(event=event) == "zh-CN"


def test_runner_auto_locale_still_detects_english_prose(tmp_path: Path) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    event = SimpleNamespace(message_str="please analyze this repository")

    assert runner._resolve_output_locale(event=event) == "en-US"


@pytest.mark.asyncio
async def test_github_job_scan_rules_and_prompt_use_auto_zh_for_url_only_command(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    event = SimpleNamespace(
        message_str="/understand 分析 https://github.com/AstrBotDevs/AstrBot",
    )

    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstrBotDevs/AstrBot",
        event=event,  # type: ignore[arg-type]
        start_task=False,
    )
    confirmation = build_ignore_confirmation(
        job.project_root, Path(job.args["graph_root"])
    )
    runner.jobs.mark_waiting_confirmation(job.job_id, confirmation)

    message = runner._confirmation_message(job)
    prompt = runner._build_skill_execution_prompt(job)

    assert job.args["locale"] == "zh-CN"
    assert "范围规则：AstrBot" in message
    old_scope_text = "Scan scope " + "confirmation"
    assert old_scope_text not in message
    assert "Generate all user-visible textual content in Simplified Chinese" in prompt


def test_ignore_review_generates_confirmation_from_project_scan(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / ".gitignore").write_text(
        "node_modules/\ncustom-cache/\n.env\n",
        encoding="utf-8",
    )
    (project / "tests").mkdir()
    src = project / "src"
    src.mkdir()
    (src / "app.test.ts").write_text("test('demo', () => {})", encoding="utf-8")
    graph_root = tmp_path / "graph" / ".understand-anything"

    confirmation = build_ignore_confirmation(project, graph_root, timeout_seconds=60)

    content = (graph_root / ".understandignore").read_text(encoding="utf-8")
    assert confirmation["kind"] == "understandignore"
    assert confirmation["summary"]["generated"] is True
    assert "custom-cache/" in confirmation["summary"]["gitignore_patterns"]
    assert "node_modules/" not in confirmation["summary"]["gitignore_patterns"]
    assert "tests" in confirmation["summary"]["detected_dirs"]
    assert "*.test.*" in confirmation["summary"]["test_file_patterns"]
    assert "# custom-cache/" in content
    assert "# tests/" in content
    assert "\ncustom-cache/" not in content
    assert "\ntests/" not in content


def test_ignore_review_existing_understandignore_is_loaded_for_advanced_review(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    graph_root = tmp_path / "graph" / ".understand-anything"
    project.mkdir()
    graph_root.mkdir(parents=True)
    (graph_root / ".understandignore").write_text("docs/\n", encoding="utf-8")

    confirmation = build_ignore_confirmation(project, graph_root)

    assert confirmation["summary"]["generated"] is False
    assert confirmation["content"] == "docs/\n"


def test_ignore_review_summarizes_current_excluded_directory_tree(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    graph_root = tmp_path / "graph" / ".understand-anything"
    (project / "docs" / "reference").mkdir(parents=True)
    (project / "src" / "generated").mkdir(parents=True)
    (project / "src" / "runtime").mkdir(parents=True)
    (project / "dist").mkdir()
    graph_root.mkdir(parents=True)
    (graph_root / ".understandignore").write_text(
        "docs/\nsrc/generated/\n!dist/\n*.test.*\n",
        encoding="utf-8",
    )

    confirmation = build_ignore_confirmation(project, graph_root)

    exclusions = confirmation["summary"]["current_exclusions"]
    assert exclusions["directories"] == ["docs", "src/generated"]
    assert exclusions["truncated"] == 0
    assert "dist" not in exclusions["directories"]


def test_ignore_review_allows_dashboard_rule_append_without_chat_reply_parser(
    tmp_path: Path,
) -> None:
    graph_root = tmp_path / ".understand-anything"
    graph_root.mkdir()
    (graph_root / ".understandignore").write_text("dist/\n", encoding="utf-8")

    content = append_ignore_patterns(graph_root, ["tests/", "docs/"])

    assert "dist/" in content
    assert "tests/" in content
    assert "docs/" in content


def test_runner_confirmation_message_is_compact_and_localized(tmp_path: Path) -> None:
    project = tmp_path / "project"
    graph_root = tmp_path / "graph"
    (project / "docs" / "reference").mkdir(parents=True)
    (project / "src" / "generated").mkdir(parents=True)
    graph_root.mkdir()
    (graph_root / ".understandignore").write_text(
        "docs/\nsrc/generated/\nvery-specific-raw-pattern/\n",
        encoding="utf-8",
    )
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "graph_root": str(graph_root),
            "project_display_name": "Demo",
            "status_ref": "Demo",
        },
    )
    confirmation = build_ignore_confirmation(project, graph_root)
    confirmation["content"] += "\nvery-specific-raw-pattern/\n"
    runner.jobs.mark_waiting_confirmation(job.job_id, confirmation)

    message = runner._confirmation_message(job)

    assert "范围规则：Demo" in message
    assert "查看进度：/understand 状态 Demo" in message
    assert "继续" not in message
    assert "取消" not in message
    assert "Dashboard" in message
    assert "当前排除目录树：" in message
    assert "- docs/" in message
    assert "- src/" in message
    assert "  - generated/" in message
    assert "Current .understandignore" not in message
    assert "very-specific-raw-pattern" not in message
    assert "Project:" not in message


@pytest.mark.asyncio
async def test_runner_applies_understandignore_defaults_without_chat_confirmation(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "raw_args": str(project),
            "project_path": str(project),
            "graph_root": str(project / ".understand-anything"),
            "source": {"type": "local"},
        },
    )

    confirmed = await runner._confirm_understandignore(
        job,
        event=None,
        timeout_seconds=0.01,
    )

    snapshot = runner.jobs.get(job.job_id)
    assert confirmed is True
    assert snapshot is not None
    assert snapshot.status is JobStatus.QUEUED
    assert snapshot.confirmation is None
    assert (project / ".understand-anything" / ".understandignore").is_file()


def test_job_request_parses_github_ref_without_treating_it_as_flag() -> None:
    parsed = parse_job_args(
        "https://github.com/AstralSolipsism/demo --ref main --full",
    )

    assert parsed.path == "https://github.com/AstralSolipsism/demo"
    assert parsed.git_ref == "main"
    assert parsed.flags == ["--full"]


def test_job_request_parses_github_proxy_without_treating_it_as_flag() -> None:
    parsed = parse_job_args(
        "https://github.com/AstralSolipsism/demo "
        "--github-proxy https://gh.llkk.cc --full",
    )
    equals_parsed = parse_job_args(
        "https://github.com/AstralSolipsism/demo "
        "--github-proxy=https://hk.gh-proxy.com",
    )

    assert parsed.path == "https://github.com/AstralSolipsism/demo"
    assert parsed.github_proxy == "https://gh.llkk.cc"
    assert parsed.flags == ["--full"]
    assert equals_parsed.github_proxy == "https://hk.gh-proxy.com"


@pytest.mark.asyncio
async def test_runner_start_job_uses_github_proxy_from_raw_args(
    tmp_path: Path,
) -> None:
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    runner.github = GitHubRepoManager(
        cache_root=tmp_path / "cache",
        artifact_root=tmp_path / "artifacts",
    )

    job = await runner.start_skill_job(
        skill_name="understand",
        raw_args=(
            "https://github.com/AstralSolipsism/demo --github-proxy https://gh.llkk.cc"
        ),
        start_task=False,
    )

    source = job.args["source"]
    assert source["github_proxy"] == "https://gh.llkk.cc"
    assert source["clone_url"] == (
        "https://gh.llkk.cc/https://github.com/AstralSolipsism/demo.git"
    )


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
        clone_failures_by_url: dict[str, str] | None = None,
        fetch_failures_by_url: dict[str, str] | None = None,
        ls_remote_failures_by_url: dict[str, str] | None = None,
        remote_refs: list[str] | None = None,
        create_subpath: str | None = None,
        create_files: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            cache_root=cache_root,
            artifact_root=cache_root.parent / "github-artifacts",
        )
        self.fail_clone = fail_clone
        self.clone_failures_by_url = clone_failures_by_url or {}
        self.fetch_failures_by_url = fetch_failures_by_url or {}
        self.ls_remote_failures_by_url = ls_remote_failures_by_url or {}
        self.remote_refs = remote_refs or ["main"]
        self.create_subpath = create_subpath
        self.create_files = create_files or {}
        self.calls: list[list[str]] = []
        self.origin_url = ""

    async def _run_git(
        self,
        args: list[str],
        *,
        check: bool = True,
        timeout_seconds: float | None = None,
    ) -> GitCommandResult:
        del timeout_seconds
        self.calls.append(args)
        if args[0] == "ls-remote":
            clone_url = args[-1]
            if message := self.ls_remote_failures_by_url.get(clone_url):
                raise GitHubRepoError(message)
            stdout = "".join(
                f"abc123\trefs/heads/{remote_ref}\n" for remote_ref in self.remote_refs
            )
            return GitCommandResult(0, stdout, "")
        if args[0] == "clone":
            clone_url = args[1]
            target_path = Path(args[-1])
            if self.fail_clone:
                raise GitHubRepoError("clone failed")
            if message := self.clone_failures_by_url.get(clone_url):
                target_path.mkdir(parents=True, exist_ok=True)
                (target_path / "partial-clone-marker.txt").write_text(
                    "partial",
                    encoding="utf-8",
                )
                raise GitHubRepoError(message)
            self.origin_url = clone_url
            Path(args[-1], ".git").mkdir(parents=True)
            if self.create_subpath:
                Path(args[-1], self.create_subpath).mkdir(parents=True)
            for relative_path, content in self.create_files.items():
                file_path = Path(args[-1], relative_path)
                file_path.parent.mkdir(parents=True, exist_ok=True)
                file_path.write_bytes(content.encode("utf-8"))
            return GitCommandResult(0, "", "")
        if "remote" in args and "set-url" in args:
            self.origin_url = args[-1]
            return GitCommandResult(0, "", "")
        if "fetch" in args:
            if message := self.fetch_failures_by_url.get(self.origin_url):
                raise GitHubRepoError(message)
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
async def test_github_repo_manager_resolve_remote_falls_back_after_direct_reset(
    tmp_path: Path,
) -> None:
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    proxy_url = f"https://edgeone.gh-proxy.com/{direct_url}"
    manager = _FakeGitHubRepoManager(
        tmp_path,
        remote_refs=["feature/x"],
        ls_remote_failures_by_url={
            direct_url: (
                "fatal: unable to access 'https://github.com/AstralSolipsism/demo.git/': "
                "Recv failure: Connection was reset"
            ),
        },
    )

    checkout = await manager.resolve_remote(
        "https://github.com/AstralSolipsism/demo/tree/feature/x/packages/app",
    )

    ls_remote_urls = [call[-1] for call in manager.calls if call[0] == "ls-remote"]
    assert ls_remote_urls[:2] == [direct_url, proxy_url]
    assert checkout.github_proxy == "https://edgeone.gh-proxy.com"
    assert checkout.ref == "feature/x"
    assert checkout.subpath == "packages/app"


@pytest.mark.asyncio
async def test_github_repo_manager_prepare_falls_back_after_clone_reset(
    tmp_path: Path,
) -> None:
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    proxy_url = f"https://edgeone.gh-proxy.com/{direct_url}"
    manager = _FakeGitHubRepoManager(
        tmp_path,
        clone_failures_by_url={
            direct_url: (
                "fatal: unable to access 'https://github.com/AstralSolipsism/demo.git/': "
                "Recv failure: Connection was reset"
            ),
        },
    )
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")

    result = await manager.prepare_with_checkout(checkout)

    clone_urls = [call[1] for call in manager.calls if call[0] == "clone"]
    assert clone_urls[:2] == [direct_url, proxy_url]
    assert result.checkout.github_proxy == "https://edgeone.gh-proxy.com"
    assert result.path == result.checkout.worktree_path
    assert not (result.checkout.worktree_path / "partial-clone-marker.txt").exists()


@pytest.mark.asyncio
async def test_github_repo_manager_prepare_falls_back_after_fetch_reset(
    tmp_path: Path,
) -> None:
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    proxy_url = f"https://edgeone.gh-proxy.com/{direct_url}"
    manager = _FakeGitHubRepoManager(
        tmp_path,
        fetch_failures_by_url={
            direct_url: (
                "fatal: unable to access 'https://github.com/AstralSolipsism/demo.git/': "
                "Recv failure: Connection was reset"
            ),
        },
    )
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")
    (checkout.worktree_path / ".git").mkdir(parents=True)

    result = await manager.prepare_with_checkout(checkout)

    set_url_calls = [call for call in manager.calls if "set-url" in call]
    assert [call[-1] for call in set_url_calls[:2]] == [direct_url, proxy_url]
    assert result.checkout.github_proxy == "https://edgeone.gh-proxy.com"


@pytest.mark.asyncio
async def test_github_repo_manager_prepare_tries_explicit_proxy_first(
    tmp_path: Path,
) -> None:
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    preferred_proxy_url = f"https://gh.llkk.cc/{direct_url}"
    manager = _FakeGitHubRepoManager(tmp_path)
    checkout = manager.resolve(
        "https://github.com/AstralSolipsism/demo",
        github_proxy="https://gh.llkk.cc",
    )

    result = await manager.prepare_with_checkout(checkout)

    clone_urls = [call[1] for call in manager.calls if call[0] == "clone"]
    assert clone_urls[0] == preferred_proxy_url
    assert result.checkout.github_proxy == "https://gh.llkk.cc"


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
    clone_calls = [call for call in manager.calls if call[0] == "clone"]
    assert len(clone_calls) == 1


@pytest.mark.asyncio
async def test_github_repo_manager_rejects_missing_ref_without_retry(
    tmp_path: Path,
) -> None:
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    manager = _FakeGitHubRepoManager(
        tmp_path,
        fetch_failures_by_url={
            direct_url: "fatal: couldn't find remote ref missing-branch",
        },
    )
    checkout = manager.resolve(
        "https://github.com/AstralSolipsism/demo",
        ref="missing-branch",
    )

    with pytest.raises(GitHubRepoError, match="couldn't find remote ref"):
        await manager.prepare(checkout)
    clone_calls = [call for call in manager.calls if call[0] == "clone"]
    assert len(clone_calls) == 1


@pytest.mark.asyncio
async def test_github_repo_manager_reports_clone_failure(tmp_path: Path) -> None:
    manager = _FakeGitHubRepoManager(tmp_path, fail_clone=True)
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")

    with pytest.raises(GitHubRepoError, match="clone failed"):
        await manager.prepare(checkout)


@pytest.mark.asyncio
async def test_github_repo_manager_reports_command_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class SlowProcess:
        returncode = None

        def __init__(self) -> None:
            self.killed = False

        async def communicate(self) -> tuple[bytes, bytes]:
            await asyncio.sleep(60)
            return b"", b""

        def kill(self) -> None:
            self.killed = True
            self.returncode = -9

        async def wait(self) -> int:
            return self.returncode or -9

    process = SlowProcess()

    async def fake_create_subprocess_exec(*_command, **_kwargs):
        return process

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )
    manager = GitHubRepoManager(
        git_bin="git-test",
        cache_root=tmp_path,
        artifact_root=tmp_path / "artifacts",
        git_timeout_seconds=0.01,
    )

    with pytest.raises(GitHubRepoError, match="timed out after"):
        await manager._run_git(["clone", "https://github.com/owner/repo.git", "repo"])

    assert process.killed is True


@pytest.mark.asyncio
async def test_github_repo_manager_reports_prepare_progress(tmp_path: Path) -> None:
    manager = _FakeGitHubRepoManager(tmp_path)
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")
    messages: list[str] = []

    await manager.prepare(checkout, progress=messages.append)

    assert messages == [
        "Trying direct GitHub for AstralSolipsism/demo.",
        "Cloning GitHub repository AstralSolipsism/demo.",
        "Checking out GitHub repository AstralSolipsism/demo.",
    ]


@pytest.mark.asyncio
async def test_github_repo_manager_awaits_async_prepare_progress(
    tmp_path: Path,
) -> None:
    manager = _FakeGitHubRepoManager(tmp_path)
    checkout = manager.resolve("https://github.com/AstralSolipsism/demo")
    messages: list[str] = []

    async def progress(message: str) -> None:
        await asyncio.sleep(0)
        messages.append(message)

    await manager.prepare(checkout, progress=progress)

    assert messages == [
        "Trying direct GitHub for AstralSolipsism/demo.",
        "Cloning GitHub repository AstralSolipsism/demo.",
        "Checking out GitHub repository AstralSolipsism/demo.",
    ]


@pytest.mark.asyncio
async def test_runner_sends_chat_progress_and_friendly_github_failure(
    tmp_path: Path,
) -> None:
    messages: list[str] = []

    class Context:
        async def send_message(self, _session, message):
            messages.append(message.get_plain_text())
            return True

    async def send(_message):
        raise RuntimeError("event send is no longer active")

    event = SimpleNamespace(
        unified_msg_origin="chat-origin",
        send=send,
    )
    runner = UnderstandAnythingRunner(
        context=Context(),  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    runner.github = _FakeGitHubRepoManager(tmp_path / "github-cache", fail_clone=True)

    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstralSolipsism/demo",
        event=event,  # type: ignore[arg-type]
    )
    await runner._tasks[job.job_id]

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FAILED
    joined_messages = "\n---\n".join(messages)
    assert "正在获取源码：demo" in joined_messages
    assert "阶段：下载 GitHub 仓库" in joined_messages
    assert "Resolving GitHub repository reference" not in joined_messages
    assert "Cloning GitHub repository" not in joined_messages
    assert "Understand Anything job update" not in joined_messages
    assert f"Job: {job.job_id}" not in joined_messages
    assert f"/understand 状态 {job.job_id}" not in joined_messages
    failure_message = messages[-1]
    assert "分析失败：demo" in failure_message
    assert "阶段：获取源码" in failure_message
    assert "原因：clone failed" in failure_message
    assert "/understand 状态 demo" in failure_message
    assert "--github-proxy" not in failure_message
    assert job.job_id not in failure_message


@pytest.mark.asyncio
async def test_runner_job_chat_notification_uses_context_proactive_send(
    tmp_path: Path,
) -> None:
    class Context:
        def __init__(self) -> None:
            self.messages: list[tuple[str, str]] = []

        async def send_message(self, session, message):
            self.messages.append((str(session), message.get_plain_text()))
            return True

    async def send(_message):
        raise RuntimeError("event send is no longer active")

    context = Context()
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:session-1",
        send=send,
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create("understand", tmp_path / "project", {})

    await runner._send_job_chat_message(
        job,
        event,  # type: ignore[arg-type]
        "background update",
        key="update",
    )

    assert context.messages == [
        ("webchat:FriendMessage:session-1", "background update")
    ]


@pytest.mark.asyncio
async def test_runner_understandignore_defaults_do_not_send_chat_prompt(
    tmp_path: Path,
) -> None:
    class Context:
        def __init__(self) -> None:
            self.messages: list[tuple[str, str]] = []

        async def send_message(self, session, message):
            self.messages.append((str(session), message.get_plain_text()))
            return True

    project = tmp_path / "project"
    graph_root = tmp_path / "graph"
    project.mkdir()
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:session-1",
    )
    context = Context()
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {"graph_root": str(graph_root)},
    )

    confirmed = await runner._confirm_understandignore(
        job,
        event,  # type: ignore[arg-type]
        timeout_seconds=5,
    )

    assert confirmed is True
    assert context.messages == []
    assert (graph_root / ".understandignore").is_file()


@pytest.mark.asyncio
async def test_runner_github_notifications_start_agent_without_scope_confirmation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DummyDispatcher:
        async def run_with_local_tools(self, **kwargs):
            marker = "UA graph output root:\n"
            prompt = str(kwargs["prompt"])
            graph_root = Path(prompt.split(marker, 1)[1].split("\n\n", 1)[0])
            graph_root.mkdir(parents=True, exist_ok=True)
            (graph_root / "knowledge-graph.json").write_text(
                json.dumps({"project": {"name": "AstrBot"}, "nodes": [], "edges": []}),
                encoding="utf-8",
            )
            (graph_root / "meta.json").write_text(
                json.dumps({"gitCommitHash": "abc"}),
                encoding="utf-8",
            )
            (graph_root / "fingerprints.json").write_text(
                json.dumps(_sample_fingerprints("abc")),
                encoding="utf-8",
            )
            return "analysis complete"

    class DummyRuntime:
        async def ensure_ready(self):
            return None

        async def run_action(self, action: str, payload: dict[str, object]):
            graph_root = Path(str(payload["graphRoot"]))
            if action == "preflight_inventory":
                return {"ok": True, "artifacts": [], "observations": [], "warnings": []}
            if action == "validate_outputs":
                _write_validation_sidecars(graph_root)
                return {
                    "ok": True,
                    "artifacts": [
                        "knowledge-graph.json",
                        "meta.json",
                        "source-inventory.json",
                        "fingerprints.json",
                        "quality-report.json",
                    ],
                    "observations": [],
                    "warnings": [],
                }
            raise AssertionError(f"Unexpected action: {action}")

    class DummySubAgentRegistry:
        def __init__(self, *_args, **_kwargs):
            pass

        def status_payload(self):
            return {"ready": True}

    class DummySubAgentDispatcher:
        def __init__(self, *_args, **_kwargs):
            pass

        def ensure_ready(self):
            return None

        def tool_set(self):
            return []

    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentRegistry",
        DummySubAgentRegistry,
    )
    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentDispatcher",
        DummySubAgentDispatcher,
    )

    context = _RegistryContext(
        _DummyConfig({"provider_settings": {"computer_use_runtime": "local"}}),
    )
    messages: list[str] = []

    async def send_message(_session, message):
        messages.append(message.get_plain_text())
        return True

    context.send_message = send_message  # type: ignore[method-assign]
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.github = _FakeGitHubRepoManager(tmp_path / "github-cache")
    runner.runtime = DummyRuntime()  # type: ignore[assignment]
    runner.dispatcher = DummyDispatcher()  # type: ignore[assignment]
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:session-1",
        message_str="/understand 分析 https://github.com/AstrBotDevs/AstrBot",
    )
    job = await runner.start_skill_job(
        skill_name="understand",
        repo_url="https://github.com/AstrBotDevs/AstrBot",
        event=event,  # type: ignore[arg-type]
    )
    await runner._tasks[job.job_id]

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert messages[0].startswith("正在获取源码：AstrBot")
    agent_index = next(
        index
        for index, message in enumerate(messages)
        if "开始生成图谱：AstrBot" in message
    )
    assert 0 < agent_index
    old_scope_text = "扫描范围" + "确认：AstrBot"
    assert old_scope_text not in "\n".join(messages)


@pytest.mark.asyncio
async def test_auto_scan_rules_do_not_register_chat_waiter_or_prompt(
    tmp_path: Path,
) -> None:
    class Context:
        def __init__(self) -> None:
            self.messages: list[str] = []

        async def send_message(self, _session, message):
            self.messages.append(message.get_plain_text())
            return True

    project = tmp_path / "project"
    graph_root = tmp_path / "graph"
    project.mkdir()
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:session-1",
    )
    context = Context()
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "graph_root": str(graph_root),
            "project_display_name": "Demo",
            "status_ref": "Demo",
        },
    )

    applied = await runner._confirm_understandignore(
        job,
        event,  # type: ignore[arg-type]
        timeout_seconds=5,
    )

    snapshot = runner.jobs.get(job.job_id)
    assert applied is True
    assert snapshot is not None
    assert snapshot.status is JobStatus.QUEUED
    assert snapshot.confirmation is None
    assert runner._confirmation_futures == {}
    assert context.messages == []
    ignore_content = (graph_root / ".understandignore").read_text(encoding="utf-8")
    assert "现在进度怎么样" not in ignore_content


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
    direct_url = "https://github.com/AstralSolipsism/demo.git"
    manager = _FakeGitHubRepoManager(
        tmp_path / "github-cache",
        create_subpath="packages/app",
        clone_failures_by_url={
            direct_url: (
                "fatal: unable to access 'https://github.com/AstralSolipsism/demo.git/': "
                "Recv failure: Connection was reset"
            ),
        },
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
    refreshed_record = runner.registry.resolve_record(project_id=record.project_id)
    assert refreshed_record.source["github_proxy"] == "https://edgeone.gh-proxy.com"


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
            "locale": "ru-RU",
        },
        headers={"Accept-Language": "zh-CN"},
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
    assert runner.calls[-1]["locale"] == "ru-RU"

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/jobs/start",
        method="POST",
        json={
            "action": "understand",
            "target": str(tmp_path),
        },
        headers={"Accept-Language": "zh-CN,zh;q=0.9"},
    ):
        response = await api.start_job()

    assert (await response.get_json())["status"] == "ok"
    assert runner.calls[-1]["repo_url"] is None
    assert runner.calls[-1]["project_path"] == str(tmp_path)
    assert runner.calls[-1]["locale"] == "zh-CN"


@pytest.mark.asyncio
async def test_web_api_chat_explain_diff_and_onboard_pass_locale(
    tmp_path: Path,
) -> None:
    class DummyRunner:
        config: dict[str, object] = {}

        def __init__(self) -> None:
            self.calls: list[dict[str, object]] = []

        async def chat(self, **kwargs):
            self.calls.append({"method": "chat", **kwargs})
            return "chat answer"

        async def explain(self, **kwargs):
            self.calls.append({"method": "explain", **kwargs})
            return "explain answer"

        async def diff(self, **kwargs):
            self.calls.append({"method": "diff", **kwargs})
            return "diff answer"

        async def onboard(self, **kwargs):
            self.calls.append({"method": "onboard", **kwargs})
            return "onboard markdown"

    runner = DummyRunner()
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/chat",
        method="POST",
        json={
            "query": "what changed?",
            "locale": "ru-RU",
            "contextItems": [{"type": "file", "path": "src/app.py"}],
        },
        headers={"Accept-Language": "zh-CN"},
    ):
        response = await api.chat()
    assert (await response.get_json())["data"]["answer"] == "chat answer"
    assert runner.calls[-1]["method"] == "chat"
    assert runner.calls[-1]["locale"] == "ru-RU"
    assert runner.calls[-1]["context_items"] == [
        {"type": "file", "path": "src/app.py"},
    ]
    assert runner.calls[-1]["include_context"] is True

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/explain",
        method="POST",
        json={
            "target": "src/app.py",
            "context_items": [{"type": "code-range", "path": "src/app.py"}],
        },
        headers={"Accept-Language": "zh-CN"},
    ):
        response = await api.explain()
    assert (await response.get_json())["data"]["answer"] == "explain answer"
    assert runner.calls[-1]["method"] == "explain"
    assert runner.calls[-1]["locale"] == "zh-CN"
    assert runner.calls[-1]["context_items"] == [
        {"type": "code-range", "path": "src/app.py"},
    ]

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/diff",
        method="POST",
        json={
            "changed_files": ["src/app.py"],
            "locale": "en-US",
            "contextItems": [{"type": "diff-file", "path": "src/app.py"}],
        },
        headers={"Accept-Language": "ru-RU"},
    ):
        response = await api.diff()
    assert (await response.get_json())["data"]["answer"] == "diff answer"
    assert runner.calls[-1]["method"] == "diff"
    assert runner.calls[-1]["locale"] == "en-US"
    assert runner.calls[-1]["context_items"] == [
        {"type": "diff-file", "path": "src/app.py"},
    ]

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/onboard",
        method="POST",
        json={"contextItems": [{"type": "node", "nodeId": "root"}]},
        headers={"Accept-Language": "ru-RU"},
    ):
        response = await api.onboard()
    assert (await response.get_json())["data"]["markdown"] == "onboard markdown"
    assert runner.calls[-1]["method"] == "onboard"
    assert runner.calls[-1]["locale"] == "ru-RU"
    assert runner.calls[-1]["context_items"] == [
        {"type": "node", "nodeId": "root"},
    ]


@pytest.mark.asyncio
async def test_web_api_lists_jobs_with_project_and_status_filters(
    tmp_path: Path,
) -> None:
    jobs = JobStore()
    first = jobs.create("understand", tmp_path / "first", {"project_id": "p1"})
    jobs.mark_running(first.job_id)
    jobs.set_progress(first.job_id, "agent", "Running workflow.", 55)
    second = jobs.create("understand", tmp_path / "second", {"project_id": "p2"})
    jobs.mark_finished(second.job_id, {"message": "done"})
    runner = SimpleNamespace(
        config={},
        registry=ProjectRegistry(tmp_path / "projects.json"),
        jobs=jobs,
    )
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/jobs?project_id=p1&status=running",
    ):
        response = await api.jobs()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert len(payload["data"]["jobs"]) == 1
    assert payload["data"]["jobs"][0]["job_id"] == first.job_id
    assert payload["data"]["jobs"][0]["progress"]["phase"] == "agent"


@pytest.mark.asyncio
async def test_web_api_serializes_job_observations_in_list_and_detail(
    tmp_path: Path,
) -> None:
    jobs = JobStore()
    job = jobs.create("understand", tmp_path / "project", {"project_id": "p1"})
    jobs.append_observation(
        job.job_id,
        kind="stage",
        level="info",
        title="准备源码",
        message="项目源码准备中。",
        stage="source",
        status="running",
    )
    runner = SimpleNamespace(
        config={},
        registry=ProjectRegistry(tmp_path / "projects.json"),
        jobs=jobs,
    )
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/jobs?project_id=p1",
    ):
        response = await api.jobs()

    list_payload = await response.get_json()
    observation = list_payload["data"]["jobs"][0]["observations"][0]
    assert observation["kind"] == "stage"
    assert observation["stage"] == "source"
    assert observation["createdAt"] == observation["timestamp"]

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/jobs/{job.job_id}",
    ):
        response = await api.get_job(job.job_id)

    detail_payload = await response.get_json()
    assert detail_payload["data"]["observations"][0]["message"] == "项目源码准备中。"


@pytest.mark.asyncio
async def test_web_api_projects_include_dashboard_status_fields(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    graph_root = project / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps({"nodes": [{"id": "file:a.py"}], "edges": []}),
        encoding="utf-8",
    )
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(project)
    jobs = JobStore()
    failed_job = jobs.create(
        "understand",
        project,
        {"project_id": record.project_id, "graph_root": str(graph_root)},
    )
    jobs.mark_failed(failed_job.job_id, "Invalid graph.")
    registry.update_status(
        record.project_id,
        ProjectStatus.FAILED,
        current_job_id=failed_job.job_id,
        last_job_id=failed_job.job_id,
        last_error="Invalid graph.",
        node_count=2,
        edge_count=3,
    )
    runner = SimpleNamespace(config={}, registry=registry, jobs=jobs)
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context("/astrbot_plugin_UnderstandAnything/projects"):
        response = await api.projects()

    payload = await response.get_json()
    project_payload = payload["data"]["projects"][0]
    assert project_payload["status"] == "failed"
    assert project_payload["current_job_id"] == failed_job.job_id
    assert project_payload["last_job_id"] == failed_job.job_id
    assert project_payload["last_error"] == "Invalid graph."
    assert project_payload["node_count"] == 2
    assert project_payload["edge_count"] == 3
    assert project_payload["graph_ready"] is True
    assert project_payload["graphReady"] is True
    assert project_payload["current_job"] is None
    assert project_payload["recent_job"]["job_id"] == failed_job.job_id
    assert project_payload["can_retry"] is True
    assert project_payload["canRetry"] is True


@pytest.mark.asyncio
async def test_web_api_confirms_dashboard_understandignore_job(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    graph_root = project / ".understand-anything"
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project,
        {
            "raw_args": str(project),
            "project_path": str(project),
            "graph_root": str(graph_root),
            "project_id": "p1",
            "source": {"type": "local"},
        },
    )
    runner.jobs.mark_waiting_confirmation(
        job.job_id,
        build_ignore_confirmation(project, graph_root),
    )
    runner._confirmation_futures[job.job_id] = (
        asyncio.get_running_loop().create_future()
    )
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/jobs/{job.job_id}/confirm",
        method="POST",
        json={"action": "update", "content": "tests/\n"},
    ):
        response = await api.confirm_job(job.job_id)

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["status"] == "waiting_confirmation"
    assert payload["data"]["confirmation"]["content"] == "tests/\n"

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/jobs/{job.job_id}/confirm",
        method="POST",
        json={"action": "continue", "content": "tests/\n"},
    ):
        response = await api.confirm_job(job.job_id)

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["status"] == "queued"
    assert runner._confirmation_futures[job.job_id].done()

    cancel_job = runner.jobs.create(
        "understand",
        project,
        {
            "raw_args": str(project),
            "project_path": str(project),
            "graph_root": str(graph_root),
            "project_id": "p1",
            "source": {"type": "local"},
        },
    )
    runner.jobs.mark_waiting_confirmation(
        cancel_job.job_id,
        build_ignore_confirmation(project, graph_root),
    )
    runner._confirmation_futures[cancel_job.job_id] = (
        asyncio.get_running_loop().create_future()
    )

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/jobs/{cancel_job.job_id}/confirm",
        method="POST",
        json={"action": "cancel"},
    ):
        response = await api.confirm_job(cancel_job.job_id)

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["status"] == "cancelled"
    assert runner._confirmation_futures[cancel_job.job_id].done()


@pytest.mark.asyncio
async def test_web_api_ignore_rules_are_advanced_and_save_only(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    (project / "tests").mkdir(parents=True)
    graph_root = project / ".understand-anything"
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(project, graph_root=graph_root)
    runner = SimpleNamespace(config={}, registry=registry, jobs=JobStore())
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        f"/astrbot_plugin_UnderstandAnything/projects/ignore?project_id={record.project_id}",
    ):
        response = await api.project_ignore()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["exists"] is False
    assert "# tests/" in payload["data"]["content"]
    assert not (graph_root / ".understandignore").exists()

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/ignore",
        method="POST",
        json={"project_id": record.project_id, "content": "tests/\n"},
    ):
        response = await api.project_ignore()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["exists"] is True
    assert payload["data"]["content"] == "tests/\n"
    assert (graph_root / ".understandignore").read_text(encoding="utf-8") == "tests/\n"


@pytest.mark.asyncio
async def test_web_api_delete_project_removes_registry_and_graph_not_source(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "project"
    graph_root = source_root / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        '{"project": {"name": "Demo"}}',
        encoding="utf-8",
    )
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(source_root)
    runner = SimpleNamespace(config={}, registry=registry, jobs=JobStore())
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        method="POST",
        json={"project_id": record.project_id},
    ):
        response = await api.delete_project()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["graph_deleted"] is True
    assert source_root.exists()
    assert not graph_root.exists()
    assert registry.get(project_id=record.project_id) is None


@pytest.mark.asyncio
async def test_web_api_delete_project_restores_previous_status_when_delete_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source_root = tmp_path / "project"
    graph_root = source_root / ".understand-anything"
    graph_root.mkdir(parents=True)
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(source_root, status=ProjectStatus.READY)
    runner = SimpleNamespace(config={}, registry=registry, jobs=JobStore())
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    def fail_rmtree(path: Path) -> None:
        raise OSError(f"cannot delete {path}")

    monkeypatch.setattr("astrbot_adapter.web_api.shutil.rmtree", fail_rmtree)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        method="POST",
        json={"project_id": record.project_id},
    ):
        response, status_code = await api.delete_project()

    payload = await response.get_json()
    assert status_code == 500
    assert payload["status"] == "error"
    restored = registry.get(project_id=record.project_id)
    assert restored is not None
    assert restored.status is ProjectStatus.READY
    assert graph_root.exists()


@pytest.mark.asyncio
async def test_web_api_delete_project_keeps_registry_when_graph_root_is_unsafe(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "project"
    source_root.mkdir()
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(source_root, graph_root=source_root)
    runner = SimpleNamespace(config={}, registry=registry, jobs=JobStore())
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        method="POST",
        json={"project_id": record.project_id},
    ):
        response, status_code = await api.delete_project()

    payload = await response.get_json()
    assert status_code == 400
    assert payload["status"] == "error"
    assert source_root.exists()
    assert registry.get(project_id=record.project_id) is not None


@pytest.mark.asyncio
async def test_web_api_delete_project_removes_registry_when_graph_is_missing(
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "project"
    source_root.mkdir()
    graph_root = source_root / ".understand-anything"
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(source_root)
    runner = SimpleNamespace(config={}, registry=registry, jobs=JobStore())
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        method="POST",
        json={"project_id": record.project_id},
    ):
        response = await api.delete_project()

    payload = await response.get_json()
    assert payload["status"] == "ok"
    assert payload["data"]["graph_deleted"] is False
    assert not graph_root.exists()
    assert registry.get(project_id=record.project_id) is None


@pytest.mark.asyncio
async def test_web_api_delete_project_rejects_active_jobs(tmp_path: Path) -> None:
    source_root = tmp_path / "project"
    graph_root = source_root / ".understand-anything"
    graph_root.mkdir(parents=True)
    registry = ProjectRegistry(tmp_path / "projects.json")
    record = registry.register(source_root)
    jobs = JobStore()
    active = jobs.create("understand", source_root, {"project_id": record.project_id})
    jobs.mark_waiting_confirmation(
        active.job_id,
        build_ignore_confirmation(source_root, graph_root),
    )
    runner = SimpleNamespace(config={}, registry=registry, jobs=jobs)
    api = UnderstandAnythingWebApi(context=None, runner=runner)  # type: ignore[arg-type]
    app = Quart(__name__)

    async with app.test_request_context(
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        method="POST",
        json={"project_id": record.project_id},
    ):
        response, status_code = await api.delete_project()

    payload = await response.get_json()
    assert status_code == 400
    assert "still running" in payload["message"]
    assert graph_root.exists()
    assert registry.get(project_id=record.project_id) is not None


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
    (runtime_root / "packages" / "assistant" / "dist").mkdir(parents=True)
    (runtime_root / "packages" / "assistant" / "dist" / "index.js").write_text(
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


def test_runtime_readiness_requires_assistant_workspace_dist(tmp_path: Path) -> None:
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
            git=_runtime_tool("git"),
        ),
        auto_repair_enabled=False,
    )

    assert readiness["repair_needed"] is True
    assert readiness["dependency_state"]["assistant_dist"] is False
    assert readiness["local_analysis_ready"] is False
    assert "incomplete" in " ".join(readiness["blocking_reasons"]).lower()


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
        elif "@understand-anything/assistant" in command:
            assistant_dist = runtime_root / "packages" / "assistant" / "dist"
            assistant_dist.mkdir(parents=True)
            (assistant_dist / "index.js").write_text("export {};", encoding="utf-8")
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
        "pnpm --filter @understand-anything/assistant build",
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
            "github_command_timeout_seconds": 42,
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
    assert "/astrbot_plugin_UnderstandAnything/jobs/<job_id>/confirm" in routes
    assert "/astrbot_plugin_UnderstandAnything/jobs/<job_id>/retry" in routes
    assert "/astrbot_plugin_UnderstandAnything/projects/check-updates" in routes
    assert payload["plugin"]["name"] == "astrbot_plugin_UnderstandAnything"
    assert payload["config"]["provider_configured"] is True
    assert "node_bin" not in payload["config"]
    assert "pnpm_bin" not in payload["config"]
    assert "git_bin" not in payload["config"]
    assert "git_available" not in payload["config"]
    assert payload["runtime"]["tools"]["node"]["supported"] is True
    assert payload["runtime"]["tools"]["git"]["available"] is True
    assert payload["config"]["cleanup_github_cache_after_analysis"] is True
    assert payload["config"]["github_command_timeout_seconds"] == 42
    assert "allowed_roots" not in payload["config"]
    assert payload["config"]["subagent_provider_configured"] is True
    assert payload["config"]["max_parallel_file_agents"] == 4
    assert payload["config"]["max_parallel_article_agents"] == 2
    assert payload["subagents"]["ready"] is False
    assert "provider_id" not in payload["config"]
    assert "secret-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert "secret-subagent-provider-id" not in json.dumps(payload, ensure_ascii=False)
    assert payload["runtime"]["dashboard_page"]["exists"] is True


def test_web_api_keeps_astrbot_dashboard_regression_routes(tmp_path: Path) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    api = UnderstandAnythingWebApi(context=None, runner=DummyRunner())  # type: ignore[arg-type]

    routes = {route for route, *_ in api.routes()}

    assert {
        "/astrbot_plugin_UnderstandAnything/status",
        "/astrbot_plugin_UnderstandAnything/runtime/repair",
        "/astrbot_plugin_UnderstandAnything/subagents/status",
        "/astrbot_plugin_UnderstandAnything/subagents/register",
        "/astrbot_plugin_UnderstandAnything/subagents/providers",
        "/astrbot_plugin_UnderstandAnything/projects",
        "/astrbot_plugin_UnderstandAnything/jobs",
        "/astrbot_plugin_UnderstandAnything/jobs/start",
        "/astrbot_plugin_UnderstandAnything/jobs/<job_id>",
        "/astrbot_plugin_UnderstandAnything/jobs/<job_id>/events",
        "/astrbot_plugin_UnderstandAnything/jobs/<job_id>/confirm",
        "/astrbot_plugin_UnderstandAnything/jobs/<job_id>/retry",
        "/astrbot_plugin_UnderstandAnything/projects/delete",
        "/astrbot_plugin_UnderstandAnything/projects/check-updates",
        "/astrbot_plugin_UnderstandAnything/projects/ignore",
        "/astrbot_plugin_UnderstandAnything/file-content",
    }.issubset(routes)


def test_web_api_registers_first_phase_webchat_routes(tmp_path: Path) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    api = UnderstandAnythingWebApi(context=None, runner=DummyRunner())  # type: ignore[arg-type]

    routes = {route for route, *_ in api.routes()}

    assert {
        "/astrbot_plugin_UnderstandAnything/webchat/sessions",
        "/astrbot_plugin_UnderstandAnything/webchat/sessions/<session_id>",
        "/astrbot_plugin_UnderstandAnything/webchat/sessions/<session_id>/rename",
        "/astrbot_plugin_UnderstandAnything/webchat/send",
        "/astrbot_plugin_UnderstandAnything/webchat/send-events",
        "/astrbot_plugin_UnderstandAnything/webchat/send-cancel",
        "/astrbot_plugin_UnderstandAnything/webchat/stop",
    }.issubset(routes)


def test_web_api_delegates_first_phase_webchat_bridge_calls(tmp_path: Path) -> None:
    class DummyRunner:
        config: dict[str, object] = {}
        security = PathSecurity([tmp_path])
        registry = SimpleNamespace(list=lambda: [])

    class FakeWebChatProxy:
        def __init__(self) -> None:
            self.calls: list[tuple[str, object]] = []

        async def list_sessions(self, username: str):
            self.calls.append(("list", username))
            return {"sessions": [{"session_id": "s1"}], "total": 1}

        async def create_session(self, username: str, **kwargs):
            self.calls.append(("create", {"username": username, **kwargs}))
            return {"session_id": "s2", "display_name": kwargs.get("display_name")}

        async def get_session(self, username: str, session_id: str):
            self.calls.append(("get", {"username": username, "session_id": session_id}))
            return {"session": {"session_id": session_id}, "history": []}

        async def rename_session(
            self,
            username: str,
            session_id: str,
            display_name: str,
        ):
            self.calls.append(
                (
                    "rename",
                    {
                        "username": username,
                        "session_id": session_id,
                        "display_name": display_name,
                    },
                ),
            )
            return {"session_id": session_id, "display_name": display_name}

        async def start_send(self, username: str, body: dict[str, object]):
            self.calls.append(("send", {"username": username, "body": body}))
            return {"request_id": "m1", "session_id": body.get("session_id")}

        def stream_send_events(
            self,
            username: str,
            request_id: str,
        ):
            self.calls.append(
                ("events", {"username": username, "request_id": request_id}),
            )

            async def stream():
                yield 'data: {"type":"end"}\n\n'

            return stream()

        async def stop_session(self, username: str, session_id: str):
            self.calls.append(
                ("stop", {"username": username, "session_id": session_id})
            )
            return {"stopped_count": 1}

        async def cancel_send(
            self,
            username: str,
            request_id: str,
            *,
            session_id: str | None = None,
        ):
            self.calls.append(
                (
                    "cancel",
                    {
                        "username": username,
                        "request_id": request_id,
                        "session_id": session_id,
                    },
                ),
            )
            return {"cancelled": True, "session_id": session_id, "stopped_count": 1}

    async def scenario() -> None:
        api = UnderstandAnythingWebApi(context=None, runner=DummyRunner())  # type: ignore[arg-type]
        fake_proxy = FakeWebChatProxy()
        api.webchat_proxy = fake_proxy  # type: ignore[assignment]
        app = Quart(__name__)

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/sessions",
        ):
            g.username = "alice"
            response = await api.webchat_sessions()
            assert (await response.get_json())["data"]["total"] == 1

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/sessions",
            method="POST",
            json={
                "display_name": "UA Demo",
                "project_id": "p1",
                "contextItems": [{"type": "node", "nodeId": "root"}],
            },
        ):
            g.username = "alice"
            response = await api.create_webchat_session()
            assert (await response.get_json())["data"]["session_id"] == "s2"

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/sessions/s2",
        ):
            g.username = "alice"
            response = await api.webchat_session("s2")
            assert (await response.get_json())["data"]["session"]["session_id"] == "s2"

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/sessions/s2/rename",
            method="POST",
            json={"display_name": "Renamed"},
        ):
            g.username = "alice"
            response = await api.rename_webchat_session("s2")
            assert (await response.get_json())["data"]["display_name"] == "Renamed"

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/send",
            method="POST",
            json={"session_id": "s2", "message": "hello", "project_id": "p1"},
        ):
            g.username = "alice"
            response = await api.webchat_send()
            assert (await response.get_json())["data"]["request_id"] == "m1"

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/send-events?request_id=m1",
        ):
            g.username = "alice"
            response = await api.webchat_send_events()
            assert response.content_type == "text/event-stream"

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/send-cancel",
            method="POST",
            json={"request_id": "m1", "session_id": "s2"},
        ):
            g.username = "alice"
            response = await api.cancel_webchat_send()
            assert (await response.get_json())["data"]["cancelled"] is True

        async with app.test_request_context(
            "/astrbot_plugin_UnderstandAnything/webchat/stop",
            method="POST",
            json={"session_id": "s2"},
        ):
            g.username = "alice"
            response = await api.stop_webchat_session()
            assert (await response.get_json())["data"]["stopped_count"] == 1

        assert fake_proxy.calls[:8] == [
            ("list", "alice"),
            (
                "create",
                {
                    "username": "alice",
                    "display_name": "UA Demo",
                    "project_ref": {"project_id": "p1"},
                    "context_items": [{"type": "node", "nodeId": "root"}],
                },
            ),
            ("get", {"username": "alice", "session_id": "s2"}),
            (
                "rename",
                {
                    "username": "alice",
                    "session_id": "s2",
                    "display_name": "Renamed",
                },
            ),
            (
                "send",
                {
                    "username": "alice",
                    "body": {
                        "session_id": "s2",
                        "message": "hello",
                        "project_id": "p1",
                    },
                },
            ),
            ("events", {"username": "alice", "request_id": "m1"}),
            (
                "cancel",
                {
                    "username": "alice",
                    "request_id": "m1",
                    "session_id": "s2",
                },
            ),
            ("stop", {"username": "alice", "session_id": "s2"}),
        ]

    asyncio.run(scenario())


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
async def test_runner_fails_graph_job_when_required_graph_is_missing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DummyDispatcher:
        called = False

        async def run_with_local_tools(self, **_kwargs):
            self.called = True
            return "analysis complete"

    class DummyRuntime:
        async def ensure_ready(self):
            return None

        async def run_action(self, action: str, _payload: dict[str, object]):
            if action in {"preflight_inventory", "validate_outputs"}:
                return {"ok": True, "artifacts": [], "observations": [], "warnings": []}
            raise AssertionError(f"Unexpected action: {action}")

    class DummySubAgentRegistry:
        def __init__(self, *_args, **_kwargs):
            pass

        def status_payload(self):
            return {"ready": True}

    class DummySubAgentDispatcher:
        def __init__(self, *_args, **_kwargs):
            pass

        def ensure_ready(self):
            return None

        def tool_set(self):
            return []

    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentRegistry",
        DummySubAgentRegistry,
    )
    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentDispatcher",
        DummySubAgentDispatcher,
    )

    project_root = tmp_path / "project"
    project_root.mkdir()
    graph_root = project_root / ".understand-anything"
    context = _RegistryContext(
        _DummyConfig({"provider_settings": {"computer_use_runtime": "local"}}),
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
        "understand",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "graph_root": str(graph_root),
            "source": {"type": "local"},
        },
    )

    task = asyncio.create_task(runner._run_skill_job(job, event=None))
    await task

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FAILED
    assert "knowledge-graph.json" in (snapshot.error or "")
    assert "meta.json" in (snapshot.error or "")
    assert "fingerprints.json" in (snapshot.error or "")
    assert "did not produce required graph file" in (snapshot.error or "")
    assert not (graph_root / ".understandignore").exists()
    assert dispatcher.called is True


@pytest.mark.asyncio
async def test_runner_runs_runtime_validation_around_agent_workflow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[str] = []

    class DummyRuntime:
        async def ensure_ready(self):
            events.append("runtime:ready")

        async def run_action(self, action: str, payload: dict[str, object]):
            events.append(f"runtime:{action}")
            assert payload["projectRoot"] == str(project_root)
            assert payload["graphRoot"] == str(graph_root)
            assert payload["jobId"] == job.job_id
            assert payload["jobKind"] == "understand"
            assert payload["locale"] == "zh-CN"
            assert payload["strictVisibleLanguage"] == "auto"
            if action == "preflight_inventory":
                return {
                    "ok": True,
                    "artifacts": ["source-inventory.json"],
                    "observations": [
                        {
                            "kind": "artifact",
                            "level": "success",
                            "title": "源码清单已生成",
                            "message": "已记录 1 个文件。",
                            "stage": "source",
                            "status": "succeeded",
                        }
                    ],
                    "warnings": [],
                }
            if action == "validate_outputs":
                (graph_root / "source-inventory.json").write_text(
                    "{}",
                    encoding="utf-8",
                )
                (graph_root / "fingerprints.json").write_text(
                    json.dumps(_sample_fingerprints("abc")),
                    encoding="utf-8",
                )
                (graph_root / "quality-report.json").write_text(
                    "{}",
                    encoding="utf-8",
                )
                return {
                    "ok": True,
                    "artifacts": [
                        "knowledge-graph.json",
                        "meta.json",
                        "source-inventory.json",
                        "fingerprints.json",
                        "quality-report.json",
                    ],
                    "observations": [
                        {
                            "kind": "quality",
                            "level": "success",
                            "title": "分析产物校验通过",
                            "message": "质量报告通过。",
                            "stage": "validate",
                            "status": "succeeded",
                        }
                    ],
                    "warnings": [],
                }
            raise AssertionError(f"Unexpected action: {action}")

    class DummyDispatcher:
        async def run_with_local_tools(self, **_kwargs):
            events.append("agent")
            graph_root.mkdir(parents=True, exist_ok=True)
            (graph_root / "knowledge-graph.json").write_text(
                json.dumps(
                    {
                        "project": {"name": "Demo", "gitCommitHash": "abc"},
                        "nodes": [],
                        "edges": [],
                    }
                ),
                encoding="utf-8",
            )
            (graph_root / "meta.json").write_text(
                json.dumps({"gitCommitHash": "abc"}),
                encoding="utf-8",
            )
            return "analysis complete"

    class DummySubAgentRegistry:
        def __init__(self, *_args, **_kwargs):
            pass

        def status_payload(self):
            return {"ready": True}

    class DummySubAgentDispatcher:
        def __init__(self, *_args, **kwargs):
            events.append(f"subagent-language:{kwargs.get('language_directive')}")

        def ensure_ready(self):
            return None

        def tool_set(self):
            return []

    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentRegistry",
        DummySubAgentRegistry,
    )
    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentDispatcher",
        DummySubAgentDispatcher,
    )

    project_root = tmp_path / "project"
    project_root.mkdir()
    graph_root = project_root / ".understand-anything"
    context = _RegistryContext(
        _DummyConfig({"provider_settings": {"computer_use_runtime": "local"}}),
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.dispatcher = DummyDispatcher()  # type: ignore[assignment]
    runner.runtime = DummyRuntime()  # type: ignore[assignment]
    project_id = ProjectRegistry.project_id_for(project_root)
    job = runner.jobs.create(
        "understand",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "project_id": project_id,
            "graph_root": str(graph_root),
            "source": {"type": "local"},
            "locale": "zh-CN",
        },
    )
    runner.registry.register(
        project_root,
        job_id=job.job_id,
        graph_root=graph_root,
        status=ProjectStatus.ANALYZING,
    )

    await runner._run_skill_job(job, event=None)

    snapshot = runner.jobs.get(job.job_id)
    project = runner.registry.get(project_id=project_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert events == [
        "runtime:ready",
        "runtime:preflight_inventory",
        (
            "subagent-language:Generate all user-visible textual content in "
            "Simplified Chinese. Keep code identifiers, file paths, schema keys, "
            "tags, and established technical terms unchanged when appropriate."
        ),
        "agent",
        "runtime:validate_outputs",
    ]
    assert [item.kind for item in snapshot.observations].count("quality") == 1
    assert project is not None
    assert project.status is ProjectStatus.READY
    assert project.current_job_id is None
    assert project.node_count == 0
    assert project.edge_count == 0


@pytest.mark.asyncio
async def test_runner_fails_when_runtime_validation_returns_not_ok(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class DummyRuntime:
        async def ensure_ready(self):
            return None

        async def run_action(self, action: str, _payload: dict[str, object]):
            if action == "preflight_inventory":
                return {"ok": True, "artifacts": [], "observations": [], "warnings": []}
            if action == "validate_outputs":
                return {
                    "ok": False,
                    "fatal": "Invalid knowledge-graph.json.",
                    "artifacts": [],
                    "observations": [
                        {
                            "kind": "error",
                            "level": "error",
                            "title": "分析产物校验失败",
                            "message": "Invalid knowledge-graph.json.",
                            "stage": "validate",
                            "status": "failed",
                        }
                    ],
                    "warnings": [],
                }
            raise AssertionError(f"Unexpected action: {action}")

    class DummyDispatcher:
        async def run_with_local_tools(self, **_kwargs):
            graph_root.mkdir(parents=True, exist_ok=True)
            (graph_root / "knowledge-graph.json").write_text(
                json.dumps({"project": {"name": "Demo"}, "nodes": [], "edges": []}),
                encoding="utf-8",
            )
            (graph_root / "meta.json").write_text(
                json.dumps({"gitCommitHash": "abc"}),
                encoding="utf-8",
            )
            return "analysis complete"

    class DummySubAgentRegistry:
        def __init__(self, *_args, **_kwargs):
            pass

        def status_payload(self):
            return {"ready": True}

    class DummySubAgentDispatcher:
        def __init__(self, *_args, **_kwargs):
            pass

        def ensure_ready(self):
            return None

        def tool_set(self):
            return []

    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentRegistry",
        DummySubAgentRegistry,
    )
    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentDispatcher",
        DummySubAgentDispatcher,
    )

    project_root = tmp_path / "project"
    project_root.mkdir()
    graph_root = project_root / ".understand-anything"
    context = _RegistryContext(
        _DummyConfig({"provider_settings": {"computer_use_runtime": "local"}}),
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.dispatcher = DummyDispatcher()  # type: ignore[assignment]
    runner.runtime = DummyRuntime()  # type: ignore[assignment]
    project_id = ProjectRegistry.project_id_for(project_root)
    job = runner.jobs.create(
        "understand",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "project_id": project_id,
            "graph_root": str(graph_root),
            "source": {"type": "local"},
            "locale": "zh-CN",
        },
    )
    runner.registry.register(
        project_root,
        job_id=job.job_id,
        graph_root=graph_root,
        status=ProjectStatus.ANALYZING,
    )

    await runner._run_skill_job(job, event=None)

    snapshot = runner.jobs.get(job.job_id)
    project = runner.registry.get(project_id=project_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FAILED
    assert snapshot.error == "Invalid knowledge-graph.json."
    assert not (graph_root / "fingerprints.json").exists()
    assert snapshot.observations[-1].level == "error"
    assert snapshot.observations[-1].stage == "validate"
    assert project is not None
    assert project.status is ProjectStatus.FAILED
    assert project.last_error == "Invalid knowledge-graph.json."


@pytest.mark.asyncio
async def test_runner_uses_compile_domain_ir_action_for_domain_jobs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actions: list[str] = []

    class DummyRuntime:
        async def ensure_ready(self):
            return None

        async def run_action(self, action: str, payload: dict[str, object]):
            actions.append(action)
            assert payload["jobKind"] == "understand-domain"
            if action == "preflight_inventory":
                return {"ok": True, "artifacts": [], "observations": [], "warnings": []}
            if action == "compile_domain_ir":
                (graph_root / "domain-graph.json").write_text(
                    json.dumps({"nodes": [], "edges": []}),
                    encoding="utf-8",
                )
                (graph_root / "quality-report.json").write_text(
                    "{}",
                    encoding="utf-8",
                )
                return {
                    "ok": True,
                    "artifacts": [
                        "intermediate/domain-analysis.json",
                        "domain-graph.json",
                        "quality-report.json",
                    ],
                    "observations": [],
                    "warnings": [],
                }
            raise AssertionError(f"Unexpected action: {action}")

    class DummyDispatcher:
        async def run_with_local_tools(self, **_kwargs):
            intermediate = graph_root / "intermediate"
            intermediate.mkdir(parents=True, exist_ok=True)
            (graph_root / "knowledge-graph.json").write_text(
                json.dumps({"project": {"name": "Demo"}, "nodes": [], "edges": []}),
                encoding="utf-8",
            )
            (graph_root / "meta.json").write_text(
                json.dumps({"gitCommitHash": "abc"}),
                encoding="utf-8",
            )
            (intermediate / "domain-analysis.json").write_text(
                json.dumps({"version": "1.0.0", "domains": []}),
                encoding="utf-8",
            )
            return "domain complete"

    class DummySubAgentRegistry:
        def __init__(self, *_args, **_kwargs):
            pass

        def status_payload(self):
            return {"ready": True}

    class DummySubAgentDispatcher:
        def __init__(self, *_args, **_kwargs):
            pass

        def ensure_ready(self):
            return None

        def tool_set(self):
            return []

    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentRegistry",
        DummySubAgentRegistry,
    )
    monkeypatch.setattr(
        "astrbot_adapter.runner.UnderstandAnythingSubAgentDispatcher",
        DummySubAgentDispatcher,
    )

    project_root = tmp_path / "project"
    project_root.mkdir()
    graph_root = project_root / ".understand-anything"
    context = _RegistryContext(
        _DummyConfig({"provider_settings": {"computer_use_runtime": "local"}}),
    )
    runner = UnderstandAnythingRunner(
        context=context,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.dispatcher = DummyDispatcher()  # type: ignore[assignment]
    runner.runtime = DummyRuntime()  # type: ignore[assignment]
    project_id = ProjectRegistry.project_id_for(project_root)
    job = runner.jobs.create(
        "understand-domain",
        project_root,
        {
            "raw_args": str(project_root),
            "project_path": str(project_root),
            "project_id": project_id,
            "graph_root": str(graph_root),
            "source": {"type": "local"},
            "locale": "zh-CN",
        },
    )
    runner.registry.register(
        project_root,
        job_id=job.job_id,
        graph_root=graph_root,
        status=ProjectStatus.ANALYZING,
    )

    await runner._run_skill_job(job, event=None)

    snapshot = runner.jobs.get(job.job_id)
    assert snapshot is not None
    assert snapshot.status is JobStatus.FINISHED
    assert actions == ["preflight_inventory", "compile_domain_ir"]


def test_runner_rejects_fingerprints_with_mismatched_commit(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    graph_root = project_root / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps({"project": {"name": "Demo"}, "nodes": [], "edges": []}),
        encoding="utf-8",
    )
    (graph_root / "meta.json").write_text(
        json.dumps({"gitCommitHash": "meta-commit"}),
        encoding="utf-8",
    )
    (graph_root / "fingerprints.json").write_text(
        json.dumps(_sample_fingerprints("fingerprint-commit")),
        encoding="utf-8",
    )
    _write_validation_sidecars(graph_root)
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project_root,
        {"graph_root": str(graph_root)},
    )

    with pytest.raises(RuntimeError, match="gitCommitHash must match meta.json"):
        runner._validate_required_outputs(job)


def test_runner_rejects_empty_fingerprint_files(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    graph_root = project_root / ".understand-anything"
    graph_root.mkdir(parents=True)
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps({"project": {"name": "Demo"}, "nodes": [], "edges": []}),
        encoding="utf-8",
    )
    (graph_root / "meta.json").write_text(
        json.dumps({"gitCommitHash": "abc"}),
        encoding="utf-8",
    )
    fingerprints = _sample_fingerprints("abc")
    fingerprints["files"] = {}
    (graph_root / "fingerprints.json").write_text(
        json.dumps(fingerprints),
        encoding="utf-8",
    )
    _write_validation_sidecars(graph_root)
    runner = UnderstandAnythingRunner(
        context=None,  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    job = runner.jobs.create(
        "understand",
        project_root,
        {"graph_root": str(graph_root)},
    )

    with pytest.raises(RuntimeError, match="files must be non-empty"):
        runner._validate_required_outputs(job)


def _run_build_fingerprints_script(
    tmp_path: Path,
    source_file_paths: list[str],
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    project_root = tmp_path / "project"
    graph_root = tmp_path / "artifact" / ".understand-anything"
    (project_root / "src").mkdir(parents=True)
    (project_root / "src" / "index.ts").write_text(
        "export function hello(name: string) { return name; }\n",
        encoding="utf-8",
    )
    input_path = tmp_path / "fingerprint-input.json"
    input_path.write_text(
        json.dumps(
            {
                "projectRoot": str(project_root),
                "graphRoot": str(graph_root),
                "sourceFilePaths": source_file_paths,
                "gitCommitHash": "abc",
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "node",
            str(PLUGIN_ROOT / "skills" / "understand" / "build-fingerprints.mjs"),
            str(input_path),
            f"--graph-root={graph_root}",
        ],
        cwd=PLUGIN_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return result, project_root, graph_root


def test_build_fingerprints_script_writes_to_graph_root(tmp_path: Path) -> None:
    result, project_root, graph_root = _run_build_fingerprints_script(
        tmp_path,
        ["src/index.ts"],
    )

    assert result.returncode == 0, result.stderr
    assert "Fingerprints baseline: 1 files" in result.stdout
    assert not (project_root / ".understand-anything" / "fingerprints.json").exists()
    payload = json.loads((graph_root / "fingerprints.json").read_text(encoding="utf-8"))
    assert payload["gitCommitHash"] == "abc"
    assert "src/index.ts" in payload["files"]


@pytest.mark.parametrize(
    ("source_file_paths", "expected_error"),
    [
        ([], "at least one file"),
        (["../secret.ts"], "escapes project root"),
        (["src/missing.ts"], "do not exist under projectRoot"),
    ],
)
def test_build_fingerprints_script_rejects_invalid_sources(
    tmp_path: Path,
    source_file_paths: list[str],
    expected_error: str,
) -> None:
    result, _project_root, graph_root = _run_build_fingerprints_script(
        tmp_path,
        source_file_paths,
    )

    assert result.returncode != 0
    assert expected_error in result.stderr
    assert not (graph_root / "fingerprints.json").exists()


def test_build_fingerprints_script_rejects_absolute_sources(
    tmp_path: Path,
) -> None:
    project_root = tmp_path / "project"
    absolute_source = project_root / "src" / "index.ts"
    result, _project_root, graph_root = _run_build_fingerprints_script(
        tmp_path,
        [str(absolute_source)],
    )

    assert result.returncode != 0
    assert "entry is absolute" in result.stderr
    assert not (graph_root / "fingerprints.json").exists()


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
    assert schema["github_command_timeout_seconds"]["default"] == 300
    assert schema["auto_update_poll_interval"]["default"] == 0
    assert "minutes" in schema["auto_update_poll_interval"]["description"].lower()
    assert schema["output_locale"]["default"] == "auto"
    assert schema["output_locale"]["options"] == ["auto", "zh-CN", "en-US", "ru-RU"]
    assert schema["output_locale"]["labels"] == [
        "Follow WebUI / chat language",
        "Simplified Chinese",
        "English",
        "Russian",
    ]


def test_auto_update_poll_interval_is_configured_in_minutes() -> None:
    assert UnderstandAnythingRunner._auto_update_poll_seconds(0) == 0
    assert UnderstandAnythingRunner._auto_update_poll_seconds("0") == 0
    assert UnderstandAnythingRunner._auto_update_poll_seconds(1) == 60
    assert UnderstandAnythingRunner._auto_update_poll_seconds("30") == 1800
    assert UnderstandAnythingRunner._auto_update_poll_seconds("invalid") == 0


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


def test_ru_i18n_has_readable_output_locale_text() -> None:
    payload = json.loads(
        (PLUGIN_ROOT / ".astrbot-plugin" / "i18n" / "ru-RU.json").read_text(
            encoding="utf-8"
        )
    )
    output_locale = payload["config"]["output_locale"]
    checked_text = [
        payload["metadata"]["short_desc"],
        payload["metadata"]["desc"],
        output_locale["description"],
        output_locale["hint"],
        *output_locale["labels"],
        payload["config"]["github_command_timeout_seconds"]["description"],
        payload["config"]["github_command_timeout_seconds"]["hint"],
        payload["config"]["auto_build"]["description"],
        payload["config"]["auto_build"]["hint"],
    ]

    assert all("?" not in text for text in checked_text)
    assert output_locale["description"] != (
        "Output language for generated Understand Anything content"
    )
    assert output_locale["labels"] == [
        "Следовать языку WebUI / чата",
        "Упрощенный китайский",
        "Английский",
        "Русский",
    ]


def test_dashboard_workspace_exposes_project_center_and_soft_job_refresh() -> None:
    source = (
        PLUGIN_ROOT
        / "understand-anything"
        / "packages"
        / "dashboard"
        / "src"
        / "components"
        / "AstrBotWorkspace.tsx"
    ).read_text(encoding="utf-8")

    assert "workspace.initialConfiguration" in source
    assert "workspace.projectPortalTitle" in source
    assert "workspace.projectManagement" in source
    assert "workspace.selectedProject" in source
    assert "workspace.projectCapabilities" in source
    assert "openProjectAssistant" in source
    assert "setAssistantMode" in source
    assert "h-[100dvh]" in source
    assert "max-h-[100dvh]" in source
    assert "lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]" in source
    assert "grid-rows-[minmax(160px,0.45fr)_minmax(0,1fr)]" in source
    assert "flex min-h-0 flex-1 flex-col overflow-hidden" in source
    assert "min-h-screen w-screen" not in source
    assert "projects/ignore" in source
    assert "projects/check-updates" in source
    assert "`jobs/${job.job_id}/retry`" in source
    assert "JobObservationConversation" in source
    assert "workspace.analysisProcess" in source
    assert "workspace.analysisTrackingDescription" in source
    assert "activeCurrentJob" in source
    assert "visibleProjectError" in source
    assert "workspace.jobRefreshDelayed" in source
    assert "environmentDetailsOpen" in source
    assert "workspace.environmentDetailsSummary" in source
    assert "<details" not in source
    assert 'setError(t("workspace.jobEventInterrupted"' not in source


def test_dashboard_job_observations_finish_without_stale_spinners() -> None:
    source = (
        PLUGIN_ROOT
        / "understand-anything"
        / "packages"
        / "dashboard"
        / "src"
        / "components"
        / "JobObservationConversation.tsx"
    ).read_text(encoding="utf-8")

    assert "effectiveObservationStatus" in source
    assert "useI18n" in source
    assert "workspace.jobConversationTitle" in source
    assert 'observation.status === "running" && terminalJobStatus(jobStatus)' in source
    assert 'return "completed";' in source
    assert "status={observation.status}" not in source
    assert "任务对话流" not in source
    assert "暂无过程观察" not in source
    assert "h-[420px]" not in source
    assert "[height:clamp(260px,38dvh,420px)]" in source


def test_astrbot_internal_access_is_centralized() -> None:
    helper_path = PLUGIN_ROOT / "astrbot_adapter" / "astrbot_host.py"
    assert helper_path.is_file()
    assert "class AstrBotHostAdapter" in helper_path.read_text(encoding="utf-8")

    business_sources = {
        "web_api.py": (PLUGIN_ROOT / "astrbot_adapter" / "web_api.py").read_text(
            encoding="utf-8"
        ),
        "subagent_registry.py": (
            PLUGIN_ROOT / "astrbot_adapter" / "subagent_registry.py"
        ).read_text(encoding="utf-8"),
        "computer_use.py": (
            PLUGIN_ROOT / "astrbot_adapter" / "computer_use.py"
        ).read_text(encoding="utf-8"),
    }

    assert "provider_manager" not in business_sources["web_api.py"]
    assert "provider_manager" not in business_sources["subagent_registry.py"]
    assert "astrbot_config_mgr" not in business_sources["computer_use.py"]
    assert (
        'getattr(persona_mgr, "personas"'
        not in business_sources["subagent_registry.py"]
    )


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


def test_domain_skill_and_prompt_require_ir_only_output() -> None:
    skill = (PLUGIN_ROOT / "skills" / "understand-domain" / "SKILL.md").read_text(
        encoding="utf-8",
    )
    prompt = (
        PLUGIN_ROOT / "astrbot_adapter" / "prompts" / "agents" / "domain-analyzer.md"
    ).read_text(encoding="utf-8")
    combined = f"{skill}\n{prompt}"

    assert "DomainAnalysisIR" in combined
    assert "$UA_GRAPH_ROOT/intermediate/domain-analysis.json" in skill
    assert "$UA_GRAPH_ROOT/intermediate/domain-analysis.json" in prompt
    assert (
        'expected_output_path="$UA_GRAPH_ROOT/intermediate/domain-analysis.json"'
        in skill
    )
    assert "compile_domain_ir" in skill
    assert "Do not create or edit `domain-graph.json`" in prompt
    assert '"nodes": [' not in prompt
    assert '"edges": [' not in prompt
    assert '"layers":' not in prompt
    assert '"tour":' not in prompt
    assert "Save to `$UA_GRAPH_ROOT/domain-graph.json`" not in skill
    assert "Clean up `$UA_GRAPH_ROOT/intermediate/domain-analysis.json`" not in skill
    assert "model: inherit" not in combined
    assert "Kimi" not in combined


def test_understand_skill_documents_incremental_and_review_fingerprint_flow() -> None:
    understand = (PLUGIN_ROOT / "skills" / "understand" / "SKILL.md").read_text(
        encoding="utf-8",
    )

    assert "$ANALYSIS_MODE" in understand
    assert "## Phase 1 — SCAN (Full and incremental only)" in understand
    assert "Run Phase 1 when `$ANALYSIS_MODE` is `full` or `incremental`" in understand
    assert '--changed-files="$UA_GRAPH_ROOT/tmp/changed-files.txt"' in understand
    assert "Do not recompute batches in Phase 2" in understand
    assert "preserve existing fingerprints" in understand
    assert (
        "sourceFilePaths` must contain the analyzed project-relative file paths"
        in understand
    )
    assert (
        "build a fallback `sourceFilePaths` list from unique `filePath` values"
        in understand
    )
    assert (
        "empty baseline, an absolute path, a `..` path, or a missing path" in understand
    )
    assert (
        "Review-only cannot create fingerprints from the existing graph" in understand
    )


def test_agent_prompts_include_language_directives() -> None:
    required_agents = [
        "project-scanner",
        "file-analyzer",
        "architecture-analyzer",
        "tour-builder",
        "domain-analyzer",
        "article-analyzer",
    ]

    for agent_name in required_agents:
        prompt = (
            PLUGIN_ROOT / "astrbot_adapter" / "prompts" / "agents" / f"{agent_name}.md"
        ).read_text(encoding="utf-8")
        assert "**Language directive:**" in prompt
        assert "Generate all user-visible textual content" in prompt


def test_project_scanner_infers_infrastructure_frameworks_after_scan() -> None:
    prompt = (
        PLUGIN_ROOT / "astrbot_adapter" / "prompts" / "agents" / "project-scanner.md"
    ).read_text(encoding="utf-8")

    assert "Do NOT infer Docker, Terraform, or CI frameworks in Step A" in prompt
    assert "derive infrastructure frameworks from Step B's `files[]` only" in prompt
    assert "`Dockerfile` or `Dockerfile.*` -> `Docker`" in prompt
    assert "`docker-compose.yml` or `docker-compose.yaml` -> `Docker Compose`" in prompt
    assert "any `*.tf` file -> `Terraform`" in prompt
    assert (
        "`.github/workflows/*.yml` or `.github/workflows/*.yaml` file -> `GitHub Actions`"
        in prompt
    )
    assert (
        "Step A manifest frameworks plus Step B file-derived infrastructure frameworks"
        in prompt
    )


def test_file_analyzer_allows_same_batch_cross_part_targets() -> None:
    prompt = (
        PLUGIN_ROOT / "astrbot_adapter" / "prompts" / "agents" / "file-analyzer.md"
    ).read_text(encoding="utf-8")

    assert "allBatchNodeIds = Set(nodes.map(n => n.id))" in prompt
    assert "same-batch cross-part targets" in prompt
    assert (
        "a node `id` in `allBatchNodeIds` from another part of the same batch" in prompt
    )
    assert (
        "Cross-batch function/class targets still need `neighborMap` symbol support"
        in prompt
    )


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


@pytest.mark.asyncio
async def test_runner_llm_actions_include_language_directive(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    graph_root = project / ".understand-anything"
    graph_root.mkdir(parents=True)
    graph = {
        "project": {"name": "Demo", "languages": ["python"]},
        "nodes": [],
        "edges": [],
        "layers": [],
    }
    (graph_root / "knowledge-graph.json").write_text(
        json.dumps(graph),
        encoding="utf-8",
    )

    class Runtime:
        def __init__(self) -> None:
            self.calls: list[tuple[str, dict[str, object]]] = []

        async def run_action(self, action: str, payload: dict[str, object]):
            self.calls.append((action, payload))
            if action == "assistant_context_bundle":
                return {
                    "ok": True,
                    "prompt": f"assistant context for {payload.get('mode')}",
                    "context": {"items": payload.get("contextItems", [])},
                    "warnings": [],
                }
            if action == "diff_markdown":
                return {
                    "markdown": "diff prompt",
                    "changedNodeIds": [],
                    "affectedNodeIds": [],
                    "unmappedFiles": [],
                }
            if action == "onboard_markdown":
                return {"markdown": "onboard markdown"}
            return {"markdown": f"{action} prompt"}

    class Dispatcher:
        def __init__(self) -> None:
            self.system_prompts: list[str] = []
            self.prompts: list[str] = []

        async def generate(self, *, prompt, event=None, system_prompt=""):
            self.prompts.append(str(prompt))
            self.system_prompts.append(system_prompt)
            return system_prompt

    runtime = Runtime()
    dispatcher = Dispatcher()
    runner = UnderstandAnythingRunner(
        context=_DummyContext(providers=[_DummyProvider("provider")]),  # type: ignore[arg-type]
        config={},
        registry_path=tmp_path / "projects.json",
    )
    runner.runtime = runtime  # type: ignore[assignment]
    runner.dispatcher = dispatcher  # type: ignore[assignment]

    await runner.chat(
        query="What does this do?",
        project_path=project,
        context_items=[{"type": "file", "path": "src/app.py"}],
        locale="zh-CN",
    )
    await runner.explain(
        target="src/app.py",
        project_path=project,
        context_items=[{"type": "code-range", "path": "src/app.py"}],
        locale="zh-CN",
    )
    await runner.diff(
        project_path=project,
        changed_files=["src/app.py"],
        context_items=[{"type": "diff-file", "path": "src/app.py"}],
        locale="zh-CN",
    )
    onboard = await runner.onboard(
        project_path=project,
        context_items=[{"type": "node", "nodeId": "root"}],
        locale="zh-CN",
    )

    assert onboard == "onboard markdown"
    assert [call[0] for call in runtime.calls] == [
        "assistant_context_bundle",
        "chat_prompt",
        "assistant_context_bundle",
        "explain_prompt",
        "assistant_context_bundle",
        "diff_markdown",
        "assistant_context_bundle",
        "onboard_markdown",
    ]
    for _action, payload in runtime.calls:
        assert payload["targetLanguage"] == "Simplified Chinese"
        assert "Keep code identifiers" in str(payload["languageDirective"])
    assert [call[1]["mode"] for call in runtime.calls[0::2]] == [
        "chat",
        "explain",
        "diff",
        "onboarding",
    ]
    assert runtime.calls[0][1]["contextItems"] == [
        {"type": "file", "path": "src/app.py"},
    ]
    assert len(dispatcher.system_prompts) == 3
    assert len(dispatcher.prompts) == 3
    for prompt in dispatcher.prompts:
        assert "assistant context for" in prompt
        assert "## Existing Graph Prompt" in prompt
    for system_prompt in dispatcher.system_prompts:
        assert "Generate all user-visible textual content in Simplified Chinese" in (
            system_prompt
        )
        assert "Keep code identifiers, file paths, schema keys, tags" in system_prompt


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


def test_subagent_registry_accepts_existing_provider_without_metadata() -> None:
    config = _DummyConfig()
    context = _RegistryContext(
        config,
        providers=[_DummyProvider("selected-provider", model="claude-sonnet-4-5")],
    )
    registry = UnderstandAnythingSubAgentRegistry(context, {})
    asyncio.run(
        registry.register_required_subagents(
            provider_id="selected-provider",
            provider_id_provided=True,
        )
    )
    config["subagent_orchestrator"].pop("metadata")

    status = registry.status_payload()

    assert status["ready"] is True
    assert status["stale_roles"] == []
    assert status["provider_override_configured"] is True

    payload = asyncio.run(registry.register_required_subagents())
    agents = config["subagent_orchestrator"]["agents"]

    assert payload["ready"] is True
    assert all(agent["provider_id"] == "selected-provider" for agent in agents)


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


def test_subagent_dispatcher_prepends_language_directive_to_role_input() -> None:
    captured: dict[str, str] = {}
    directive = (
        "Generate all user-visible textual content in Simplified Chinese. "
        "Keep code identifiers, file paths, schema keys, tags, and established "
        "technical terms unchanged when appropriate."
    )

    async def fake_handoff(_handoff, _run_context, tool_args):
        captured["input"] = str(tool_args["input"])
        return "ok"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
        language_directive=directive,
    )

    result = asyncio.run(
        dispatcher.run_role(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            input_text="analyze this batch",
        )
    )

    assert result["status"] == "ok"
    assert captured["input"].startswith("Language directive for this UA worker task:")
    assert directive in captured["input"]
    assert "project descriptions, node summaries, layer descriptions" in captured["input"]
    assert "domain flow/step summaries" in captured["input"]
    assert captured["input"].endswith("analyze this batch")

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


def test_subagent_batch_output_accepts_part_files(tmp_path: Path) -> None:
    intermediate = tmp_path / "graph" / "intermediate"
    intermediate.mkdir(parents=True)
    expected = intermediate / "batch-7.json"
    part_1 = intermediate / "batch-7-part-1.json"
    part_2 = intermediate / "batch-7-part-2.json"
    invalid_part = intermediate / "batch-7-part-final.json"

    async def fake_handoff(_handoff, _run_context, _tool_args):
        part_2.write_text('{"nodes": [], "edges": []}', encoding="utf-8")
        part_1.write_text('{"nodes": [], "edges": []}', encoding="utf-8")
        invalid_part.write_text('{"nodes": [], "edges": []}', encoding="utf-8")
        return "wrote parts"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            batches=[
                {
                    "id": "7",
                    "input": "batch 7",
                    "expected_output_path": str(expected),
                }
            ],
        )
    )

    assert result["status"] == "ok"
    output = result["results"][0]["output"]
    assert output["exists"] is True
    assert output["output_mode"] == "parts"
    assert output["part_files"] == [
        str(part_1.resolve(strict=False)),
        str(part_2.resolve(strict=False)),
    ]


def test_subagent_batch_output_ignores_non_numeric_part_files(
    tmp_path: Path,
) -> None:
    intermediate = tmp_path / "graph" / "intermediate"
    intermediate.mkdir(parents=True)
    expected = intermediate / "batch-7.json"
    invalid_part = intermediate / "batch-7-part-final.json"

    async def fake_handoff(_handoff, _run_context, _tool_args):
        invalid_part.write_text('{"nodes": [], "edges": []}', encoding="utf-8")
        return "wrote invalid part"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            batches=[
                {
                    "id": "7",
                    "input": "batch 7",
                    "expected_output_path": str(expected),
                }
            ],
        )
    )

    assert result["status"] == "missing_output"
    output = result["results"][0]["output"]
    assert output["exists"] is False
    assert "part_files" not in output


def test_subagent_batch_output_still_reports_missing_without_file_or_parts(
    tmp_path: Path,
) -> None:
    expected = tmp_path / "graph" / "intermediate" / "batch-8.json"
    expected.parent.mkdir(parents=True)

    async def fake_handoff(_handoff, _run_context, _tool_args):
        return "no output"

    dispatcher = UnderstandAnythingSubAgentDispatcher(
        _DummyContext(),  # type: ignore[arg-type]
        handoff_executor=fake_handoff,
    )

    result = asyncio.run(
        dispatcher.run_batches(
            _dummy_event(),  # type: ignore[arg-type]
            role="file-analyzer",
            batches=[
                {
                    "id": "8",
                    "input": "batch 8",
                    "expected_output_path": str(expected),
                }
            ],
        )
    )

    assert result["status"] == "missing_output"
    output = result["results"][0]["output"]
    assert output["exists"] is False
    assert "part_files" not in output


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
