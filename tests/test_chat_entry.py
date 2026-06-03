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
)
from astrbot_adapter.job_store import JobStatus, JobStore


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

    def format_job_source_started_message(self, job, job_label: str = "analysis"):
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

    local_with_ignore = parser.parse(r"分析 D:\AboutDEV\demo，忽略 tests dist")
    assert local_with_ignore.intent == "start_analysis"
    assert local_with_ignore.source == r"D:\AboutDEV\demo"
    assert local_with_ignore.options["ignore"] == ["tests", "dist"]


def test_chat_command_parser_marks_ambiguous_content_for_lightweight_llm() -> None:
    parsed = ChatCommandParser().parse("这个 WebChat 代理怎么接上的？")

    assert parsed.intent == "unknown"
    assert parsed.requires_lightweight_llm is True
    assert parsed.query == "这个 WebChat 代理怎么接上的？"


@pytest.mark.parametrize(
    "legacy_text",
    [
        "analyze D:/repo",
        "status Demo",
        "chat Demo 怎么接入的",
        "dashboard",
        "diff",
        "domain",
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


def test_tool_project_action_rejects_content_actions_without_final_llm(
    tmp_path: Path,
) -> None:
    runner = _DummyRunner(tmp_path)
    runner.calls.clear()

    payload = json.loads(
        asyncio.run(
            ToolResultPresenter(runner).project_action(
                "ask",
                event=SimpleNamespace(),
                project_hint="Demo",
            )
        )
    )

    assert payload["status"] == "error"
    assert payload["action"] == "ask"
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
