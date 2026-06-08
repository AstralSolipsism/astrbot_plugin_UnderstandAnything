# ruff: noqa: E402

from __future__ import annotations

import json
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))
ASTRBOT_ROOT = PLUGIN_ROOT.parent / "AstrBot"
if ASTRBOT_ROOT.exists():
    sys.path.insert(0, str(ASTRBOT_ROOT))

from astrbot_adapter.chat_entry import (
    ChatActionExecutor,
    ChatCommandParser,
    ChatIntent,
    ChatState,
    ChatStateResolver,
    ChatStateMachine,
    LightweightIntentParser,
    ToolResultPresenter,
    UnderstandAnythingChatEntry,
)
from astrbot_adapter.job_store import JobStatus, JobStore
from astrbot_adapter.project_registry import ProjectStatus
from astrbot_adapter.webchat_proxy import WebChatSessionContextStore


class _DummyRunner:
    def __init__(self, tmp_path: Path) -> None:
        self.calls: list[dict[str, object]] = []
        self.jobs = JobStore()
        self.registry = SimpleNamespace(list=lambda: [])
        self.runtime = SimpleNamespace(repair=self._repair)
        self.tmp_path = tmp_path

    async def _repair(self):
        self.calls.append({"method": "repair"})
        return {"ready": True, "actions": []}

    async def start_skill_job(self, **kwargs):
        self.calls.append({"method": "start_skill_job", **kwargs})
        job = self.jobs.create(
            str(kwargs.get("skill_name") or "understand"),
            self.tmp_path / "project",
            {
                "project_display_name": "Demo",
                "status_ref": "Demo",
                "started_notification_sent": False,
            },
        )
        return job

    async def start_project_update_check_job(self, **kwargs):
        self.calls.append({"method": "start_project_update_check_job", **kwargs})
        job = self.jobs.create(
            "check-updates",
            self.tmp_path / "project",
            {
                "project_display_name": "Demo",
                "status_ref": "Demo",
                "started_notification_sent": False,
            },
        )
        return job

    def format_job_source_started_message(self, job, job_label: str = "analysis"):
        if job_label == "check-updates":
            return f"已开始检查更新：{job.args.get('project_display_name')}"
        return f"已开始分析：{job.args.get('project_display_name')}"

    def format_job_status(self, project_ref=None):
        return f"分析状态：{project_ref or '当前项目'}"

    async def chat(self, **kwargs):
        self.calls.append({"method": "chat", **kwargs})
        return "图谱回答"

    async def explain(self, **kwargs):
        self.calls.append({"method": "explain", **kwargs})
        return "组件解释"

    async def diff(self, **kwargs):
        self.calls.append({"method": "diff", **kwargs})
        return "改动分析"

    async def onboard(self, **kwargs):
        self.calls.append({"method": "onboard", **kwargs})
        return "项目导览"


class _Project:
    def __init__(
        self,
        tmp_path: Path,
        *,
        project_id: str = "p1",
        name: str = "Demo",
        status: ProjectStatus = ProjectStatus.READY,
    ) -> None:
        self.project_id = project_id
        self.name = name
        self.aliases = [name]
        self.path = str(tmp_path / name)
        self.graph_root = str(tmp_path / name / ".understand-anything")
        self.status = status

    def to_dict(self) -> dict[str, object]:
        return {
            "project_id": self.project_id,
            "name": self.name,
            "aliases": self.aliases,
            "path": self.path,
            "graph_root": self.graph_root,
            "status": self.status.value,
        }


class _GraphStore:
    def __init__(self, graphs: dict[str, dict[str, object]]) -> None:
        self.graphs = graphs

    def read_json(self, name: str):
        if name not in self.graphs:
            raise FileNotFoundError(name)
        return self.graphs[name]


def test_chat_command_parser_handles_operations_without_lightweight_llm() -> None:
    parser = ChatCommandParser()

    assert parser.parse("").intent == "status"
    assert parser.parse("状态").intent == "status"
    assert parser.parse("进度").intent == "status"
    assert parser.parse("停止").intent == "stop_job"
    assert parser.parse("取消").intent == "stop_job"
    assert parser.parse("打开面板").intent == "open_dashboard"
    assert parser.parse("诊断").intent == "diagnose"
    assert parser.parse("修复").intent == "repair_runtime"

    local = parser.parse(r"分析 D:\AboutDEV\demo")
    assert local.intent == "start_analysis"
    assert local.source == r"D:\AboutDEV\demo"
    assert local.requires_lightweight_llm is False

    github = parser.parse("分析 https://github.com/AstralSolipsism/demo")
    assert github.intent == "start_analysis"
    assert github.source == "https://github.com/AstralSolipsism/demo"
    assert github.requires_lightweight_llm is False

    rerun = parser.parse("重新分析，忽略 node_modules dist")
    assert rerun.intent == "rerun_analysis"
    assert rerun.options["ignore"] == ["node_modules", "dist"]

    rerun_project = parser.parse("重新分析 AstrBot，忽略 tests dist")
    assert rerun_project.intent == "rerun_analysis"
    assert rerun_project.project_hint == "AstrBot"
    assert rerun_project.options["ignore"] == ["tests", "dist"]

    update_project = parser.parse("更新图谱 AstrBot，忽略 docs tmp")
    assert update_project.intent == "update_analysis"
    assert update_project.project_hint == "AstrBot"
    assert update_project.options["ignore"] == ["docs", "tmp"]

    check_updates = parser.parse("检查更新 AstrBot")
    assert check_updates.intent == "check_updates"
    assert check_updates.project_hint == "AstrBot"

    local_with_ignore = parser.parse(r"分析 D:\AboutDEV\demo，忽略 tests dist")
    assert local_with_ignore.intent == "start_analysis"
    assert local_with_ignore.source == r"D:\AboutDEV\demo"
    assert local_with_ignore.options["ignore"] == ["tests", "dist"]


def test_chat_command_parser_handles_command_group_payloads() -> None:
    parser = ChatCommandParser()

    status = parser.parse("状态 Demo")
    assert status.intent == "status"
    assert status.project_hint == "Demo"

    project_list = parser.parse("项目")
    assert project_list.intent == "project_context"

    select_project = parser.parse("项目 Demo")
    assert select_project.intent == "select_project"
    assert select_project.project_hint == "Demo"

    generate_domain = parser.parse("生成领域视图 Demo")
    assert generate_domain.intent == "rerun_analysis"
    assert generate_domain.project_hint == "Demo"

    refresh_domain = parser.parse("领域 刷新 Demo")
    assert refresh_domain.intent == "rerun_analysis"
    assert refresh_domain.project_hint == "Demo"

    panel = parser.parse("面板")
    assert panel.intent == "open_dashboard"


@pytest.mark.parametrize(
    "content_text",
    [
        "解释 webchat_proxy.py",
        "diff 当前改动",
        "onboarding Demo",
        "领域 订单流程怎么串起来",
        "这个 WebChat 代理怎么接上的？",
    ],
)
def test_chat_command_parser_routes_content_to_normal_llm_chat(
    content_text: str,
) -> None:
    parsed = ChatCommandParser().parse(content_text)

    assert parsed.intent == "content_requires_llm"
    assert parsed.query == content_text
    assert parsed.requires_lightweight_llm is False


def test_chat_command_parser_marks_ambiguous_content_for_lightweight_llm() -> None:
    parsed = ChatCommandParser().parse("这个 WebChat 代理怎么接上的？")

    assert parsed.intent == "content_requires_llm"
    assert parsed.requires_lightweight_llm is False
    assert parsed.query == "这个 WebChat 代理怎么接上的？"


@pytest.mark.parametrize(
    "legacy_text",
    [
        "analyze D:/repo",
        "status Demo",
        "chat Demo 怎么接入的",
        "dashboard",
        "explain webchat_proxy.py",
        "knowledge docs",
        "onboard Demo",
    ],
)
def test_chat_command_parser_rejects_legacy_subcommands_without_aliasing(
    legacy_text: str,
) -> None:
    parsed = ChatCommandParser().parse(legacy_text)

    assert parsed.intent == "legacy_removed"
    assert parsed.target == legacy_text.split()[0]
    assert parsed.requires_lightweight_llm is False


def test_lightweight_parser_uses_single_stateless_structured_prompt() -> None:
    calls: list[dict[str, object]] = []

    class Dispatcher:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            return json.dumps(
                {
                    "intent": "ask",
                    "confidence": 0.82,
                    "query": "这个接入怎么做的？",
                    "mode": "ask",
                    "project_hint": "Demo",
                },
                ensure_ascii=False,
            )

    runner = SimpleNamespace(
        dispatcher=Dispatcher(),
        registry=SimpleNamespace(list=lambda: []),
    )

    parsed = asyncio.run(
        LightweightIntentParser(runner).parse(
            "这个接入怎么做的？",
            state=ChatState(name="graph_ready"),
            event=SimpleNamespace(),
        )
    )

    assert parsed.intent == "ask"
    assert parsed.query == "这个接入怎么做的？"
    assert parsed.requires_lightweight_llm is True
    assert len(calls) == 1
    assert calls[0]["system_prompt"] == ""
    prompt = str(calls[0]["prompt"])
    assert "user_text" in prompt
    assert "available_intents" in prompt
    assert "generate_domain" not in prompt
    assert "generate_domain_view" not in prompt
    assert "refresh_domain" not in prompt
    assert "history" not in prompt.casefold()
    assert "persona" not in prompt.casefold()
    assert "knowledge-graph" not in prompt.casefold()
    assert "file_content" not in prompt.casefold()


def test_state_machine_has_no_public_scope_confirmation_state() -> None:
    assert "awaiting_scope_confirmation" not in ChatStateMachine.PUBLIC_STATES

    machine = ChatStateMachine()
    running = machine.validate(
        ChatState(name="analysis_running"),
        ChatIntent(intent="start_analysis", source="D:/repo"),
    )
    blocked = machine.validate(
        ChatState(name="blocked_subagents", blockers=["SubAgent 未就绪"]),
        ChatIntent(intent="start_analysis", source="D:/repo"),
    )

    assert running.allowed is False
    assert "已经有分析任务" in running.message
    assert blocked.allowed is False
    assert "SubAgent 未就绪" in blocked.message


def test_state_resolver_blocks_start_when_runtime_is_not_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.context = object()
    runner.config = {"auto_build": False}
    runner.runtime = SimpleNamespace(tools=lambda: object())

    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.runtime_readiness",
        lambda *_args, **_kwargs: {
            "local_analysis_ready": False,
            "github_analysis_ready": False,
            "blocking_reasons": ["Node.js 22+ 未就绪"],
            "github_blocking_reason": "git 不可用",
        },
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.computer_use_status",
        lambda *_args, **_kwargs: {"enabled": True, "blocking_reason": ""},
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.UnderstandAnythingSubAgentRegistry",
        lambda *_args, **_kwargs: SimpleNamespace(status_payload=lambda: {"ready": True}),
    )

    state = ChatStateResolver(runner).resolve(
        intent=ChatIntent(intent="start_analysis", source=str(tmp_path / "project")),
        event=SimpleNamespace(unified_msg_origin="webchat:session"),
    )

    assert state.name == "blocked_runtime"
    assert state.blockers == ["Node.js 22+ 未就绪"]


def test_state_resolver_blocks_start_when_subagents_are_not_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.context = object()
    runner.config = {}
    runner.runtime = SimpleNamespace(tools=lambda: object())

    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.runtime_readiness",
        lambda *_args, **_kwargs: {
            "local_analysis_ready": True,
            "github_analysis_ready": True,
            "blocking_reasons": [],
            "github_blocking_reason": "",
        },
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.computer_use_status",
        lambda *_args, **_kwargs: {"enabled": True, "blocking_reason": ""},
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.UnderstandAnythingSubAgentRegistry",
        lambda *_args, **_kwargs: SimpleNamespace(
            status_payload=lambda: {
                "ready": False,
                "missing_roles": ["file-analyzer"],
                "stale_roles": [],
                "unloaded_roles": [],
            }
        ),
    )

    state = ChatStateResolver(runner).resolve(
        intent=ChatIntent(intent="start_analysis", source=str(tmp_path / "project")),
        event=SimpleNamespace(unified_msg_origin="webchat:session"),
    )

    assert state.name == "blocked_subagents"
    assert state.blockers == ["SubAgent 未就绪：file-analyzer"]


def test_state_resolver_blocks_start_when_computer_use_is_disabled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.context = object()
    runner.config = {}
    runner.runtime = SimpleNamespace(tools=lambda: object())

    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.runtime_readiness",
        lambda *_args, **_kwargs: {
            "local_analysis_ready": True,
            "github_analysis_ready": True,
            "blocking_reasons": [],
            "github_blocking_reason": "",
        },
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.computer_use_status",
        lambda *_args, **_kwargs: {
            "enabled": False,
            "blocking_reason": "Computer Use 未启用",
        },
    )
    monkeypatch.setattr(
        "astrbot_adapter.chat_entry.UnderstandAnythingSubAgentRegistry",
        lambda *_args, **_kwargs: SimpleNamespace(status_payload=lambda: {"ready": True}),
    )

    state = ChatStateResolver(runner).resolve(
        intent=ChatIntent(intent="start_analysis", source=str(tmp_path / "project")),
        event=SimpleNamespace(unified_msg_origin="webchat:session"),
    )

    assert state.name == "blocked_computer_use"
    assert state.blockers == ["Computer Use 未启用"]


def test_command_executor_starts_analysis_without_scope_confirmation(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            ChatIntent(intent="start_analysis", source="https://github.com/a/b"),
            event=SimpleNamespace(),
        )
    )

    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1]["repo_url"] == "https://github.com/a/b"
    assert "确认" not in message
    assert "继续" not in message


def test_command_executor_stops_latest_active_job(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    active = runner.jobs.create("understand", tmp_path / "project", {})
    runner.jobs.mark_running(active.job_id)
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            ChatIntent(intent="stop_job"),
            event=SimpleNamespace(),
        )
    )

    assert runner.jobs.get(active.job_id).status is JobStatus.CANCELLED
    assert "已停止" in message


@pytest.mark.parametrize(
    ("intent", "expected_method"),
    [
        (
            ChatIntent(
                intent="content_requires_llm",
                query="这个接入怎么做的？",
                mode="ask",
            ),
            "chat",
        ),
        (
            ChatIntent(
                intent="content_requires_llm",
                query="解释 webchat_proxy.py",
                target="webchat_proxy.py",
                mode="explain",
            ),
            "explain",
        ),
        (ChatIntent(intent="content_requires_llm", query="当前改动", mode="diff"), "diff"),
        (
            ChatIntent(intent="content_requires_llm", query="项目导览", mode="onboard"),
            "onboard",
        ),
        (ChatIntent(intent="domain", query="订单流程怎么串起来", mode="domain"), "chat"),
    ],
)
def test_command_executor_answers_content_requests_when_graph_ready(
    tmp_path: Path,
    intent: ChatIntent,
    expected_method: str,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, project_id="p1", name="Demo")
    runner.registry = SimpleNamespace(list=lambda: [project])
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            intent,
            event=SimpleNamespace(),
            project_kwargs={"project_ref": "Demo"},
        )
    )

    assert runner.calls[-1]["method"] == expected_method
    assert message in {"图谱回答", "组件解释", "改动分析", "项目导览"}


def test_understand_content_request_asks_project_when_ambiguous(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
    )
    entry = UnderstandAnythingChatEntry(runner)

    message = asyncio.run(
        entry.execute_text(
            "解释 webchat_proxy.py",
            event=SimpleNamespace(),
        ),
    )

    assert "当前匹配到多个项目" in message
    assert runner.calls == []


def test_command_executor_updates_existing_graph_without_full_reanalysis(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            ChatIntent(intent="update_analysis", project_hint="Demo"),
            event=SimpleNamespace(),
        )
    )

    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1]["skill_name"] == "understand"
    assert runner.calls[-1]["project_ref"] == "Demo"
    assert runner.calls[-1].get("flags", []) == []
    assert "已开始分析" in message


def test_command_executor_reruns_existing_graph_with_full_reanalysis_flag(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            ChatIntent(intent="rerun_analysis", project_hint="Demo"),
            event=SimpleNamespace(),
        )
    )

    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1]["skill_name"] == "understand"
    assert runner.calls[-1]["project_ref"] == "Demo"
    assert runner.calls[-1]["flags"] == ["--full"]
    assert "已开始分析" in message


def test_command_executor_checks_updates_without_starting_analysis(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(list=lambda: [_Project(tmp_path)])
    executor = ChatActionExecutor(runner)

    message = asyncio.run(
        executor.execute(
            ChatIntent(intent="check_updates", project_hint="Demo"),
            event=SimpleNamespace(),
        )
    )

    assert runner.calls[-1]["method"] == "start_project_update_check_job"
    assert runner.calls[-1]["project_id"] == "p1"
    assert "检查更新" in message
    assert "分析" not in message


def test_chat_entry_select_project_writes_webchat_context(tmp_path: Path) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path)
    runner.registry = SimpleNamespace(list=lambda: [project])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    entry = UnderstandAnythingChatEntry(runner, context_store=context_store)
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:webchat!alice!s1",
    )

    message = asyncio.run(entry.execute_text("使用项目 Demo", event=event))

    context = context_store.context_for_session("s1")
    assert "已切换项目上下文：Demo" in message
    assert context is not None
    assert context["username"] == "alice"
    assert context["project_ref"]["project_id"] == "p1"
    assert context["project_ref"]["project_name"] == "Demo"
    assert context["project_ref"]["project_path"] == project.path


def test_chat_entry_project_command_lists_current_and_available_projects(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project_a = _Project(tmp_path, project_id="p1", name="Demo")
    project_b = _Project(tmp_path, project_id="p2", name="AstrBot")
    runner.registry = SimpleNamespace(list=lambda: [project_a, project_b])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    context_store.update(
        session_id="s1",
        username="alice",
        project_ref={"project_id": "p2", "project_name": "AstrBot"},
    )
    entry = UnderstandAnythingChatEntry(runner, context_store=context_store)
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:webchat!alice!s1",
    )

    message = asyncio.run(entry.execute_text("项目", event=event))

    assert "当前项目：AstrBot" in message
    assert "Demo" in message
    assert "AstrBot" in message
    assert "/understand 项目 Demo" in message


def test_tool_result_presenter_returns_structured_state_without_llm(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    running = runner.jobs.create(
        "understand",
        tmp_path / "project",
        {"project_display_name": "Demo", "status_ref": "Demo"},
    )
    runner.jobs.mark_running(running.job_id)

    payload = json.loads(ToolResultPresenter(runner).project_state())

    assert payload["state"] == "analysis_running"
    assert payload["running_job"]["status"] == "running"
    assert "ask" not in payload["available_actions"]
    assert payload["dashboard_url"]
    assert payload["llm_used"] is False


def test_project_state_lists_candidates_when_project_is_ambiguous(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
    )

    payload = json.loads(ToolResultPresenter(runner).project_state(""))

    assert payload["state"] == "ambiguous_project"
    assert payload["requires_project_selection"] is True
    assert payload["project_candidates"] == [
        {
            "project_id": "p1",
            "project_name": "Alpha",
            "project_ref": "Alpha",
            "project_path": str(tmp_path / "Alpha"),
        },
        {
            "project_id": "p2",
            "project_name": "Beta",
            "project_ref": "Beta",
            "project_path": str(tmp_path / "Beta"),
        },
    ]


def test_project_state_does_not_require_selection_for_single_ready_project(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, project_id="p1", name="Demo")],
    )

    payload = json.loads(ToolResultPresenter(runner).project_state(""))

    assert payload["state"] == "graph_ready"
    assert payload["requires_project_selection"] is False
    assert payload["project"]["name"] == "Demo"
    assert "update_analysis" in payload["available_actions"]
    assert payload["tool_guidance"]["update_analysis"]


def test_project_state_reports_stale_graph_with_update_action(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Demo", status=ProjectStatus.STALE)
        ],
    )

    payload = json.loads(ToolResultPresenter(runner).project_state(""))

    assert payload["state"] == "graph_stale"
    assert payload["requires_project_selection"] is False
    assert "update_analysis" in payload["available_actions"]
    assert "rerun_analysis" in payload["available_actions"]


def test_tool_project_action_returns_structured_action_contract(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "status",
                event=SimpleNamespace(),
            )
        )
    )

    assert payload["status"] == "ok"
    assert payload["action"] == "status"
    assert payload["job"] is None
    assert payload["project"] is None
    assert isinstance(payload["next_actions"], list)
    assert payload["llm_used"] is False


def test_tool_project_action_does_not_start_analysis_for_ready_project(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, name="Demo", status=ProjectStatus.READY)
    runner.registry = SimpleNamespace(list=lambda: [project])

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "start_analysis",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "already_analyzed"
    assert payload["action"] == "start_analysis"
    assert payload["project"]["project_id"] == "p1"
    assert "ua_retrieve_project_context" in payload["message"]
    assert "retrieve_project_context" in payload["next_actions"]
    assert "start_analysis" not in payload["next_actions"]
    assert "rerun_analysis" not in payload["next_actions"]
    assert runner.calls == []
    assert payload["llm_used"] is False


def test_tool_project_action_does_not_restart_ready_project_by_source_path(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, name="Demo", status=ProjectStatus.READY)
    runner.registry = SimpleNamespace(list=lambda: [project])

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "start_analysis",
                event=SimpleNamespace(),
                source=project.path,
            )
        )
    )

    assert payload["status"] == "already_analyzed"
    assert runner.calls == []


def test_tool_project_action_allows_new_source_when_other_project_is_ready(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Existing", status=ProjectStatus.READY)]
    )
    new_source = str(tmp_path / "NewProject")

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "start_analysis",
                event=SimpleNamespace(),
                source=new_source,
            )
        )
    )

    assert payload["status"] == "ok"
    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1]["project_path"] == new_source


def test_tool_project_action_requires_explicit_rerun_confirmation(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Demo", status=ProjectStatus.READY)]
    )

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "rerun_analysis",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "confirmation_required"
    assert payload["action"] == "rerun_analysis"
    assert "用户明确要求" in payload["message"]
    assert "刷新" not in payload["message"]
    assert runner.calls == []
    assert payload["llm_used"] is False


def test_tool_project_action_updates_ready_project_without_full_reanalysis(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Demo", status=ProjectStatus.READY)]
    )

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "update_analysis",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "ok"
    assert payload["action"] == "update_analysis"
    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1].get("flags", []) == []
    assert runner.calls[-1]["project_ref"] == "Demo"
    assert payload["llm_used"] is False


def test_tool_project_action_explicit_rerun_uses_full_reanalysis_flag(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Demo", status=ProjectStatus.READY)]
    )

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "rerun_analysis",
                event=SimpleNamespace(),
                project_hint="Demo",
                user_explicit_rerun=True,
            )
        )
    )

    assert payload["status"] == "ok"
    assert payload["action"] == "rerun_analysis"
    assert runner.calls[-1]["method"] == "start_skill_job"
    assert runner.calls[-1]["flags"] == ["--full"]
    assert runner.calls[-1]["project_ref"] == "Demo"
    assert payload["llm_used"] is False


def test_tool_project_action_checks_updates_without_starting_analysis(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Demo", status=ProjectStatus.READY)]
    )

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "check_updates",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "ok"
    assert payload["action"] == "check_updates"
    assert runner.calls[-1]["method"] == "start_project_update_check_job"
    assert runner.calls[-1]["project_id"] == "p1"
    assert not any(call["method"] == "start_skill_job" for call in runner.calls)
    assert payload["llm_used"] is False


def test_tool_project_action_blocks_update_without_existing_graph(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [_Project(tmp_path, name="Demo", status=ProjectStatus.EMPTY)]
    )

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "update_analysis",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "blocked"
    assert "还没有可更新的图谱" in payload["message"]
    assert runner.calls == []


def test_tool_project_action_select_project_writes_webchat_context(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path)
    runner.registry = SimpleNamespace(list=lambda: [project])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    presenter = ToolResultPresenter(runner, context_store=context_store)
    event = SimpleNamespace(
        unified_msg_origin="webchat:FriendMessage:webchat!alice!s1",
    )

    payload = json.loads(
        asyncio.run(
            presenter.project_action(
                "select_project",
                event=event,
                project_hint="Demo",
            )
        )
    )

    context = context_store.context_for_session("s1")
    assert payload["status"] == "ok"
    assert payload["action"] == "select_project"
    assert payload["project"]["project_id"] == "p1"
    assert context is not None
    assert context["project_ref"]["project_name"] == "Demo"
    assert payload["llm_used"] is False


def test_tool_project_action_select_project_writes_generic_chat_context(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path)
    runner.registry = SimpleNamespace(list=lambda: [project])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    presenter = ToolResultPresenter(
        runner,
        context_store=context_store,
    )
    umo = "telegram:FriendMessage:s1"

    payload = json.loads(
        asyncio.run(
            presenter.project_action(
                "select_project",
                event=SimpleNamespace(unified_msg_origin=umo),
                project_hint="Demo",
            )
        )
    )

    context = context_store.context_for_umo(umo)
    assert payload["status"] == "ok"
    assert payload["action"] == "select_project"
    assert payload["project"]["project_id"] == "p1"
    assert context is not None
    assert context["project_ref"]["project_name"] == "Demo"
    assert payload["llm_used"] is False


def test_tool_select_project_context_updates_generic_chat_context(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    project = _Project(tmp_path, project_id="p1", name="Demo")
    runner.registry = SimpleNamespace(list=lambda: [project])
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    presenter = ToolResultPresenter(runner, context_store=context_store)
    event = SimpleNamespace(
        unified_msg_origin="telegram:FriendMessage:telegram!alice!chat-1",
    )

    payload = json.loads(
        presenter.select_project_context(
            "Demo",
            event=event,
        ),
    )

    assert payload["status"] == "ok"
    assert payload["project"]["project_id"] == "p1"
    assert context_store.project_ref_for_umo(event.unified_msg_origin) == {
        "project_id": "p1",
        "project_name": "Demo",
        "project_path": project.path,
        "project_ref": "Demo",
    }


def test_tool_select_project_context_blocks_ambiguous_project(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Demo"),
            _Project(tmp_path, project_id="p2", name="Demo"),
        ],
    )
    presenter = ToolResultPresenter(
        runner,
        context_store=WebChatSessionContextStore(tmp_path / "contexts.json"),
    )

    payload = json.loads(
        presenter.select_project_context(
            "Demo",
            event=SimpleNamespace(unified_msg_origin="telegram:chat"),
        ),
    )

    assert payload["status"] == "blocked"
    assert "多个项目" in payload["message"]


@pytest.mark.parametrize(
    "action",
    ["generate_domain", "generate_domain_view", "refresh_domain"],
)
def test_tool_project_action_does_not_expose_domain_generation_aliases(
    tmp_path: Path,
    action: str,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(list=lambda: [_Project(tmp_path)])

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                action,
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "error"
    assert payload["action"] == action
    assert "不支持" in payload["message"]
    assert "重新分析" not in payload["message"]
    assert "next_actions" not in payload
    assert runner.calls == []
    assert payload["llm_used"] is False


@pytest.mark.parametrize("action", ["ask", "explain", "diff", "onboard", "domain"])
def test_tool_project_action_rejects_content_actions_without_final_llm(
    tmp_path: Path,
    action: str,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.calls.clear()

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                action,
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "error"
    assert payload["action"] == action
    assert "ua_retrieve_project_context" in payload["message"]
    assert runner.calls == []
    assert payload["llm_used"] is False


def test_tool_retrieve_context_returns_retrieval_contract_without_llm(
    tmp_path: Path,
) -> None:
    class Store:
        def read_json(self, name: str):
            assert name == "knowledge-graph.json"
            return {
                "project": {"name": "Demo"},
                "nodes": [
                    {
                        "id": "n1",
                        "name": "WebChat proxy",
                        "type": "module",
                        "filePath": "astrbot_adapter/webchat_proxy.py",
                        "summary": "Connects dashboard messages to native WebChat.",
                    }
                ],
                "edges": [],
            }

    runner = _DummyRunner(tmp_path)
    runner.project_store = lambda **_kwargs: Store()

    payload = json.loads(
        ToolResultPresenter(runner).retrieve_project_context(
            "WebChat proxy",
            project_hint="Demo",
        )
    )

    assert payload["status"] == "ok"
    assert payload["refs"][0]["filePath"] == "astrbot_adapter/webchat_proxy.py"
    assert payload["nodes"][0]["id"] == "n1"
    assert payload["files"] == ["astrbot_adapter/webchat_proxy.py"]
    assert payload["snippets"][0]["summary"]
    assert payload["graph_summary"]["node_count"] == 1
    assert payload["confidence"] > 0
    assert payload["llm_used"] is False


def test_tool_retrieve_context_uses_project_hint_without_switching_default(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    context_store = WebChatSessionContextStore(tmp_path / "contexts.json")
    context_store.update(
        session_id="s1",
        username="alice",
        project_ref={"project_id": "p1", "project_name": "ProjectA"},
    )

    def project_store(**kwargs):
        project_ref = kwargs.get("project_ref")
        return _GraphStore(
            {
                "knowledge-graph.json": {
                    "project": {"name": project_ref},
                    "nodes": [
                        {
                            "id": f"file:{project_ref}",
                            "name": f"{project_ref} WebChat",
                            "type": "module",
                            "filePath": f"{project_ref}/webchat.py",
                            "summary": f"{project_ref} 的 WebChat 入口。",
                        }
                    ],
                    "edges": [],
                }
            }
        )

    runner.project_store = project_store

    payload = json.loads(
        ToolResultPresenter(
            runner,
            context_store=context_store,
        ).retrieve_project_context(
            "WebChat",
            project_hint="ProjectB",
        )
    )

    context = context_store.context_for_session("s1")
    assert payload["status"] == "ok"
    assert payload["graph_summary"]["project"]["name"] == "ProjectB"
    assert payload["refs"][0]["filePath"] == "ProjectB/webchat.py"
    assert context is not None
    assert context["project_ref"]["project_name"] == "ProjectA"


def test_retrieve_project_context_errors_with_multiple_projects_and_no_hint(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.registry = SimpleNamespace(
        list=lambda: [
            _Project(tmp_path, project_id="p1", name="Alpha"),
            _Project(tmp_path, project_id="p2", name="Beta"),
        ],
    )
    runner.project_store = lambda **kwargs: (_ for _ in ()).throw(
        ValueError("Multiple Understand Anything projects are registered."),
    )

    payload = json.loads(
        ToolResultPresenter(runner).retrieve_project_context("入口在哪里？"),
    )

    assert payload["status"] == "project_selection_required"
    assert payload["project_candidates"][0]["project_name"] == "Alpha"
    assert payload["project_candidates"][1]["project_name"] == "Beta"


def test_retrieve_project_context_uses_explicit_project_hint(
    tmp_path: Path,
) -> None:
    graph = {
        "project": {"name": "Alpha"},
        "nodes": [
            {
                "id": "file:src/main.py",
                "type": "file",
                "name": "main.py",
                "filePath": "src/main.py",
                "summary": "Entry point",
            },
        ],
        "edges": [],
    }

    class Runner(_DummyRunner):
        def project_store(self, **kwargs):
            assert kwargs["project_ref"] == "Alpha"
            return _GraphStore({"knowledge-graph.json": graph})

    payload = json.loads(
        ToolResultPresenter(Runner(tmp_path)).retrieve_project_context(
            "入口",
            project_hint="Alpha",
        ),
    )

    assert payload["status"] == "ok"
    assert payload["graph"]["project"]["name"] == "Alpha"


def test_tool_retrieve_context_reads_domain_graph_for_domain_mode(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.project_store = lambda **_kwargs: _GraphStore(
        {
            "domain-graph.json": {
                "project": {"name": "Demo"},
                "nodes": [
                    {
                        "id": "domain:orders",
                        "name": "订单领域",
                        "type": "domain",
                        "summary": "处理订单创建、支付和履约。",
                    },
                    {
                        "id": "flow:checkout",
                        "name": "结算流程",
                        "type": "flow",
                        "summary": "从购物车到支付成功的流程。",
                    },
                ],
                "edges": [
                    {
                        "source": "domain:orders",
                        "target": "flow:checkout",
                        "type": "contains_flow",
                    }
                ],
            }
        }
    )

    payload = json.loads(
        ToolResultPresenter(runner).retrieve_project_context(
            "订单流程",
            project_hint="Demo",
            mode="domain",
        )
    )

    assert payload["status"] == "ok"
    assert payload["mode"] == "domain"
    assert payload["context_kind"] == "domain"
    assert payload["domain_graph_ready"] is True
    assert payload["refs"][0]["id"] == "domain:orders"
    assert payload["graph_summary"]["edge_count"] == 1
    assert payload["llm_used"] is False


def test_tool_retrieve_context_reports_missing_domain_graph(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.project_store = lambda **_kwargs: _GraphStore(
        {
            "knowledge-graph.json": {
                "project": {"name": "Demo"},
                "nodes": [{"id": "file:main.py", "name": "main.py"}],
                "edges": [],
            }
        }
    )

    payload = json.loads(
        ToolResultPresenter(runner).retrieve_project_context(
            "订单流程",
            project_hint="Demo",
            mode="domain",
        )
    )

    assert payload["status"] == "analysis_incomplete"
    assert payload["mode"] == "domain"
    assert payload["domain_graph_ready"] is False
    assert "rerun_analysis" not in payload["next_actions"]
    assert "ask_user_to_reanalyze" in payload["next_actions"]
    assert "generate_domain" not in payload["next_actions"]
    assert payload["llm_used"] is False
