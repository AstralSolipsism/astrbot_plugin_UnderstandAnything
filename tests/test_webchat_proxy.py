from __future__ import annotations

import asyncio
import builtins
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from astrbot_adapter.webchat_proxy import (
    WebChatSessionContextStore,
    UnderstandAnythingWebChatProxy,
    build_webchat_unified_msg_origin,
    session_id_from_webchat_umo,
)


class FakePlatformSession:
    def __init__(
        self,
        session_id: str,
        *,
        creator: str = "alice",
        platform_id: str = "webchat",
        display_name: str | None = None,
        is_group: int = 0,
    ) -> None:
        now = datetime(2026, 6, 3, tzinfo=timezone.utc)
        self.session_id = session_id
        self.platform_id = platform_id
        self.creator = creator
        self.display_name = display_name
        self.is_group = is_group
        self.created_at = now
        self.updated_at = now


class FakeHistoryRecord:
    def __init__(
        self,
        record_id: int,
        *,
        platform_id: str = "webchat",
        user_id: str = "s1",
        content: dict[str, Any] | None = None,
        sender_id: str = "alice",
        sender_name: str = "alice",
        llm_checkpoint_id: str | None = None,
    ) -> None:
        now = datetime(2026, 6, 3, tzinfo=timezone.utc)
        self.id = record_id
        self.platform_id = platform_id
        self.user_id = user_id
        self.content = content or {}
        self.sender_id = sender_id
        self.sender_name = sender_name
        self.llm_checkpoint_id = llm_checkpoint_id
        self.created_at = now
        self.updated_at = now

    def model_dump(self) -> dict[str, Any]:
        return dict(self.__dict__)


class FakeDb:
    def __init__(self) -> None:
        self.sessions: dict[str, FakePlatformSession] = {}
        self.created: list[dict[str, Any]] = []
        self.updated: list[dict[str, Any]] = []
        self.attachments: list[SimpleNamespace] = []
        self.next_id = 1

    async def create_platform_session(self, **kwargs: Any) -> FakePlatformSession:
        session_id = str(kwargs.get("session_id") or f"s{self.next_id}")
        self.next_id += 1
        session = FakePlatformSession(
            session_id,
            creator=str(kwargs["creator"]),
            platform_id=str(kwargs.get("platform_id") or "webchat"),
            display_name=kwargs.get("display_name"),
            is_group=int(kwargs.get("is_group") or 0),
        )
        self.sessions[session_id] = session
        self.created.append(kwargs)
        return session

    async def get_platform_session_by_id(
        self,
        session_id: str,
    ) -> FakePlatformSession | None:
        return self.sessions.get(session_id)

    async def get_platform_sessions_by_creator_paginated(self, **kwargs: Any):
        sessions = [
            {"session": session}
            for session in self.sessions.values()
            if session.creator == kwargs["creator"]
            and (kwargs.get("platform_id") is None or session.platform_id == kwargs.get("platform_id"))
        ]
        return sessions, len(sessions)

    async def update_platform_session(self, **kwargs: Any) -> None:
        session = self.sessions[str(kwargs["session_id"])]
        if kwargs.get("display_name") is not None:
            session.display_name = str(kwargs["display_name"])
        self.updated.append(kwargs)

    async def insert_attachment(
        self,
        path: str,
        attach_type: str,
        mime_type: str,
    ) -> SimpleNamespace:
        attachment = SimpleNamespace(
            attachment_id=f"att-{len(self.attachments) + 1}",
            path=path,
            type=attach_type,
            mime_type=mime_type,
        )
        self.attachments.append(attachment)
        return attachment


class FakeHistoryManager:
    def __init__(self) -> None:
        self.records: list[FakeHistoryRecord] = []
        self.inserted: list[dict[str, Any]] = []
        self.fail_next_insert = False

    async def get(self, **kwargs: Any) -> list[FakeHistoryRecord]:
        return [
            record
            for record in self.records
            if record.platform_id == kwargs["platform_id"] and record.user_id == kwargs["user_id"]
        ]

    async def insert(self, **kwargs: Any) -> FakeHistoryRecord:
        if self.fail_next_insert:
            self.fail_next_insert = False
            raise RuntimeError("history insert failed")
        record = FakeHistoryRecord(
            len(self.records) + 1,
            platform_id=str(kwargs["platform_id"]),
            user_id=str(kwargs["user_id"]),
            content=dict(kwargs["content"]),
            sender_id=str(kwargs.get("sender_id") or ""),
            sender_name=str(kwargs.get("sender_name") or ""),
            llm_checkpoint_id=kwargs.get("llm_checkpoint_id"),
        )
        self.records.append(record)
        self.inserted.append(kwargs)
        return record


class FakeQueueManager:
    def __init__(self) -> None:
        self.queues: dict[str, asyncio.Queue] = {}
        self.back_queues: dict[str, asyncio.Queue] = {}
        self.removed: list[str] = []
        self.request_conversation: dict[str, str] = {}

    def get_or_create_queue(self, conversation_id: str) -> asyncio.Queue:
        return self.queues.setdefault(conversation_id, asyncio.Queue())

    def get_or_create_back_queue(
        self,
        request_id: str,
        conversation_id: str | None = None,
    ) -> asyncio.Queue:
        if conversation_id:
            self.request_conversation[request_id] = conversation_id
        return self.back_queues.setdefault(request_id, asyncio.Queue())

    def remove_back_queue(self, request_id: str) -> None:
        self.removed.append(request_id)
        self.back_queues.pop(request_id, None)
        self.request_conversation.pop(request_id, None)

    def list_back_request_ids(self, conversation_id: str) -> list[str]:
        return [
            request_id
            for request_id, mapped_conversation_id in self.request_conversation.items()
            if mapped_conversation_id == conversation_id
        ]


class FakeActiveRegistry:
    def __init__(self) -> None:
        self.origins: list[str] = []

    def request_agent_stop_all(self, umo: str) -> int:
        self.origins.append(umo)
        return 2


def make_proxy(tmp_path: Path):
    db = FakeDb()
    history = FakeHistoryManager()
    queue_mgr = FakeQueueManager()
    active_registry = FakeActiveRegistry()
    context = SimpleNamespace(
        get_db=lambda: db,
        message_history_manager=history,
        attachments_dir=tmp_path / "attachments",
    )
    proxy = UnderstandAnythingWebChatProxy(
        context,
        queue_mgr=queue_mgr,
        active_event_registry=active_registry,
        context_store=WebChatSessionContextStore(tmp_path / "webchat-contexts.json"),
    )
    return proxy, db, history, queue_mgr, active_registry


def test_webchat_umo_helpers_round_trip_session_id() -> None:
    umo = build_webchat_unified_msg_origin("alice", "session-1")

    assert umo == "webchat:FriendMessage:webchat!alice!session-1"
    assert session_id_from_webchat_umo(umo) == "session-1"
    assert session_id_from_webchat_umo("aiocqhttp:FriendMessage:abc") is None


def test_context_store_maps_webchat_umo_to_ua_project_context(tmp_path: Path) -> None:
    store = WebChatSessionContextStore(tmp_path / "contexts.json")

    store.update(
        session_id="s1",
        username="alice",
        project_ref={"project_id": "p1", "project_name": "Demo", "project_path": ""},
        context_items=[{"type": "node", "nodeId": "root"}],
    )

    assert store.project_ref_for_umo(
        "webchat:FriendMessage:webchat!alice!s1",
    ) == {"project_id": "p1", "project_name": "Demo"}
    assert store.context_for_session("s1")["context_items"] == [
        {"type": "node", "nodeId": "root"},
    ]


def test_proxy_constructor_lazily_loads_astrbot_runtime_singletons(monkeypatch) -> None:
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name.startswith("astrbot.core.platform.sources.webchat") or name.startswith(
            "astrbot.core.utils.active_event_registry",
        ):
            raise AssertionError(f"unexpected eager import: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    proxy = UnderstandAnythingWebChatProxy(SimpleNamespace())

    assert proxy.context is not None


def test_main_llm_tools_resolve_default_project_from_webchat_context() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert "self.webchat_context_store = self.web_api.webchat_proxy.context_store" in source
    assert "def _effective_project_kwargs(" in source
    assert "def _effective_status_project_ref(" in source
    assert "project_hint or self._effective_status_project_ref(event)" in source
    assert "project_kwargs=self._effective_project_kwargs(event, project_hint)" in source
    assert "project_kwargs=self._effective_project_kwargs(event, project_hint)," in source
    assert "unified_msg_origin" in source


def run(coro):
    return asyncio.run(coro)


def test_proxy_creates_lists_reads_and_renames_native_webchat_sessions(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, _queue_mgr, _active_registry = make_proxy(tmp_path)
        history.records.append(
            FakeHistoryRecord(
                1,
                user_id="s1",
                content={"type": "user", "message": [{"type": "plain", "text": "hi"}]},
            ),
        )

        created = await proxy.create_session(
            "alice",
            display_name="UA Demo",
            project_ref={"project_id": "p1"},
            context_items=[{"type": "file", "path": "src/app.py"}],
        )
        assert created["session_id"] == "s1"
        assert db.created[-1]["platform_id"] == "webchat"
        assert db.created[-1]["creator"] == "alice"

        listed = await proxy.list_sessions("alice")
        assert listed["sessions"][0]["session_id"] == "s1"
        assert listed["sessions"][0]["display_name"] == "UA Demo"

        loaded = await proxy.get_session("alice", "s1")
        assert loaded["session"]["session_id"] == "s1"
        assert loaded["history"][0]["content"]["message"][0]["text"] == "hi"
        assert loaded["ua_context"]["project_ref"] == {"project_id": "p1"}

        renamed = await proxy.rename_session("alice", "s1", "Renamed")
        assert renamed["display_name"] == "Renamed"
        assert db.updated[-1] == {"session_id": "s1", "display_name": "Renamed"}

    run(scenario())


def test_proxy_send_routes_message_through_webchat_queue_and_records_user_history(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, queue_mgr, _active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")

        started = await proxy.start_send(
            "alice",
            {
                "session_id": "s1",
                "message": "请解释项目",
                "message_id": "m1",
                "selected_provider": "provider-a",
                "selected_model": "model-a",
                "contextItems": [{"type": "node", "nodeId": "root"}],
                "project_id": "p1",
            },
        )

        assert started["request_id"] == "m1"
        queued = await queue_mgr.queues["s1"].get()
        assert queued[0] == "alice"
        assert queued[1] == "s1"
        assert queued[2]["message"] == [{"type": "plain", "text": "请解释项目"}]
        assert queued[2]["selected_provider"] == "provider-a"
        assert history.inserted[0]["content"] == {
            "type": "user",
            "message": [{"type": "plain", "text": "请解释项目"}],
        }
        assert proxy.context_store.project_ref_for_session("s1") == {"project_id": "p1"}

    run(scenario())


def test_proxy_streams_back_queue_events_and_persists_bot_plain_text(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, queue_mgr, _active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")
        await proxy.start_send("alice", {"session_id": "s1", "message": "hi", "message_id": "m1"})
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "plain", "data": "你好", "streaming": True},
        )
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "complete", "data": "", "streaming": True},
        )
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "end", "data": "", "streaming": True},
        )

        chunks = []
        async for chunk in proxy.stream_send_events("alice", "m1", heartbeat_seconds=0.01):
            chunks.append(chunk)

        assert any('"type": "session_id"' in chunk for chunk in chunks)
        assert any('"type": "message_saved"' in chunk for chunk in chunks)
        assert history.inserted[-1]["sender_id"] == "bot"
        assert history.inserted[-1]["content"] == {
            "type": "bot",
            "message": [{"type": "plain", "text": "你好"}],
        }
        assert queue_mgr.removed == ["m1"]

    run(scenario())


def test_proxy_persists_native_webchat_message_parts_and_agent_stats(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, queue_mgr, _active_registry = make_proxy(tmp_path)
        attachments_dir = tmp_path / "attachments"
        attachments_dir.mkdir()
        (attachments_dir / "diagram.png").write_bytes(b"png")
        (attachments_dir / "report.md").write_text("# report", encoding="utf-8")
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")
        await proxy.start_send("alice", {"session_id": "s1", "message": "hi", "message_id": "m1"})
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "plain", "data": "答案", "streaming": True},
        )
        await queue_mgr.back_queues["m1"].put(
            {
                "message_id": "m1",
                "type": "plain",
                "data": "推理",
                "streaming": True,
                "chain_type": "reasoning",
            },
        )
        await queue_mgr.back_queues["m1"].put(
            {
                "message_id": "m1",
                "type": "plain",
                "data": '{"id":"tool-1","name":"ua_status","args":{"target":"demo"}}',
                "streaming": True,
                "chain_type": "tool_call",
            },
        )
        await queue_mgr.back_queues["m1"].put(
            {
                "message_id": "m1",
                "type": "plain",
                "data": '{"tool_call_id":"tool-1","content":"ready"}',
                "streaming": True,
                "chain_type": "tool_call_result",
            },
        )
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "image", "data": "[IMAGE]diagram.png", "streaming": True},
        )
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "file", "data": "[FILE]report.md", "streaming": True},
        )
        await queue_mgr.back_queues["m1"].put(
            {
                "message_id": "m1",
                "type": "plain",
                "data": '{"tokens":12}',
                "streaming": True,
                "chain_type": "agent_stats",
            },
        )
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "end", "data": "", "streaming": True},
        )

        chunks = []
        async for chunk in proxy.stream_send_events("alice", "m1", heartbeat_seconds=0.01):
            chunks.append(chunk)

        saved = history.inserted[-1]["content"]
        assert saved == {
            "type": "bot",
            "message": [
                {"type": "plain", "text": "答案"},
                {"type": "think", "think": "推理"},
                {
                    "type": "tool_call",
                    "tool_calls": [
                        {"id": "tool-1", "name": "ua_status", "args": {"target": "demo"}},
                    ],
                },
                {
                    "type": "tool_call_result",
                    "tool_call_id": "tool-1",
                    "content": "ready",
                },
                {"type": "image", "attachment_id": "att-1", "filename": "diagram.png"},
                {"type": "file", "attachment_id": "att-2", "filename": "report.md"},
            ],
            "agent_stats": {"tokens": 12},
        }
        assert db.attachments[0].type == "image"
        assert db.attachments[1].type == "file"
        assert any('"type": "attachment_saved"' in chunk for chunk in chunks)

    run(scenario())


def test_proxy_flushes_partial_bot_text_when_stream_closes_before_end(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, queue_mgr, _active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")
        await proxy.start_send("alice", {"session_id": "s1", "message": "hi", "message_id": "m1"})
        await queue_mgr.back_queues["m1"].put(
            {"message_id": "m1", "type": "plain", "data": "partial", "streaming": True},
        )

        stream = proxy.stream_send_events("alice", "m1", heartbeat_seconds=0.01)
        assert '"type": "session_id"' in await anext(stream)
        assert '"type": "user_message_saved"' in await anext(stream)
        assert '"type": "plain"' in await anext(stream)

        await stream.aclose()

        assert history.inserted[-1]["sender_id"] == "bot"
        assert history.inserted[-1]["content"] == {
            "type": "bot",
            "message": [{"type": "plain", "text": "partial"}],
        }
        assert queue_mgr.removed == ["m1"]

    run(scenario())


def test_proxy_does_not_enqueue_when_user_history_persistence_fails(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, history, queue_mgr, _active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")
        history.fail_next_insert = True

        with pytest.raises(RuntimeError, match="history insert failed"):
            await proxy.start_send("alice", {"session_id": "s1", "message": "hi", "message_id": "m1"})

        assert queue_mgr.queues == {}
        assert queue_mgr.back_queues == {}
        assert queue_mgr.request_conversation == {}
        assert "m1" not in proxy._pending_sends

    run(scenario())


def test_proxy_send_cancel_cleans_pending_back_queue_and_requests_stop(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        proxy, db, _history, queue_mgr, active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")
        await proxy.start_send("alice", {"session_id": "s1", "message": "hi", "message_id": "m1"})

        cancelled = await proxy.cancel_send("alice", "m1", session_id="s1")

        assert cancelled == {"cancelled": True, "session_id": "s1", "stopped_count": 2}
        assert "m1" not in proxy._pending_sends
        assert "m1" not in queue_mgr.back_queues
        assert queue_mgr.removed == ["m1"]
        assert active_registry.origins == [
            "webchat:FriendMessage:webchat!alice!s1",
        ]

    run(scenario())


def test_proxy_streams_sse_error_for_unknown_send_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        proxy, _db, _history, queue_mgr, _active_registry = make_proxy(tmp_path)

        chunks = []
        async for chunk in proxy.stream_send_events("alice", "missing", heartbeat_seconds=0.01):
            chunks.append(chunk)

        assert chunks == [
            'data: {"type": "error", "data": "Unknown WebChat send request."}\n\n',
        ]
        assert queue_mgr.removed == []

    run(scenario())


def test_proxy_stop_uses_webchat_unified_message_origin(tmp_path: Path) -> None:
    async def scenario() -> None:
        proxy, db, _history, _queue_mgr, active_registry = make_proxy(tmp_path)
        await db.create_platform_session(creator="alice", platform_id="webchat", session_id="s1")

        stopped = await proxy.stop_session("alice", "s1")

        assert stopped == {"stopped_count": 2}
        assert active_registry.origins == [
            "webchat:FriendMessage:webchat!alice!s1",
        ]

    run(scenario())
