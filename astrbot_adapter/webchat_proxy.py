from __future__ import annotations

import asyncio
import json
import mimetypes
import time
import uuid
from collections.abc import AsyncIterator
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .constants import PLUGIN_NAME, PLUGIN_ROOT

WEBCHAT_PLATFORM_ID = "webchat"
WEBCHAT_FRIEND_MESSAGE = "FriendMessage"
SSE_HEARTBEAT = ": heartbeat\n\n"
MEDIA_EVENT_PREFIXES = {
    "image": "[IMAGE]",
    "record": "[RECORD]",
    "file": "[FILE]",
    "video": "[VIDEO]",
}


def build_webchat_unified_msg_origin(
    username: str,
    session_id: str,
    *,
    platform_id: str = WEBCHAT_PLATFORM_ID,
    is_group: bool = False,
) -> str:
    message_type = "GroupMessage" if is_group else WEBCHAT_FRIEND_MESSAGE
    return f"{platform_id}:{message_type}:{platform_id}!{username}!{session_id}"


def session_id_from_webchat_umo(umo: str) -> str | None:
    if not umo.startswith(f"{WEBCHAT_PLATFORM_ID}:"):
        return None
    try:
        _platform, _message_type, session = umo.split(":", 2)
        platform_id, _username, session_id = session.split("!", 2)
    except ValueError:
        return None
    if platform_id != WEBCHAT_PLATFORM_ID or not session_id:
        return None
    return session_id


class WebChatSessionContextStore:
    """Stores UA routing context for native AstrBot WebChat sessions.

    This is intentionally not a conversation store. Chat messages stay in
    AstrBot's PlatformMessageHistory; this file only maps a WebChat session to
    the UA project/context the dashboard selected.
    """

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else _default_context_path()

    def update(
        self,
        *,
        session_id: str,
        username: str,
        project_ref: dict[str, Any] | None = None,
        context_items: list[Any] | None = None,
    ) -> dict[str, Any]:
        payload = self._read()
        existing = payload.get(session_id)
        now = time.time()
        record = {
            "session_id": session_id,
            "username": username,
            "project_ref": _clean_project_ref(project_ref or {}),
            "context_items": context_items if isinstance(context_items, list) else [],
            "created_at": (
                existing.get("created_at")
                if isinstance(existing, dict) and existing.get("created_at")
                else now
            ),
            "updated_at": now,
        }
        payload[session_id] = record
        self._write(payload)
        return record

    def context_for_session(self, session_id: str) -> dict[str, Any] | None:
        record = self._read().get(session_id)
        return dict(record) if isinstance(record, dict) else None

    def project_ref_for_session(self, session_id: str) -> dict[str, Any] | None:
        record = self.context_for_session(session_id)
        if not record:
            return None
        project_ref = record.get("project_ref")
        return dict(project_ref) if isinstance(project_ref, dict) else None

    def project_ref_for_umo(self, umo: str) -> dict[str, Any] | None:
        session_id = session_id_from_webchat_umo(umo)
        if not session_id:
            return None
        return self.project_ref_for_session(session_id)

    def context_for_umo(self, umo: str) -> dict[str, Any] | None:
        session_id = session_id_from_webchat_umo(umo)
        if not session_id:
            return None
        return self.context_for_session(session_id)

    def _read(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _write(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
            encoding="utf-8",
        )


class WebChatBotMessageAccumulator:
    def __init__(self) -> None:
        self.parts: list[dict[str, Any]] = []
        self.pending_text = ""

    def has_content(self) -> bool:
        return bool(self.parts or self.pending_text)

    def add_plain(
        self,
        text: str,
        *,
        chain_type: Any,
        streaming: bool,
    ) -> None:
        if chain_type == "reasoning":
            self._flush_pending_text()
            self._append_think(text)
            return
        if chain_type == "tool_call":
            self._flush_pending_text()
            tool_call = self._parse_json_object(text)
            if tool_call:
                self.parts.append({"type": "tool_call", "tool_calls": [tool_call]})
            return
        if chain_type == "tool_call_result":
            self._flush_pending_text()
            result = self._parse_json_object(text)
            if result:
                part: dict[str, Any] = {"type": "tool_call_result"}
                if "tool_call_id" in result:
                    part["tool_call_id"] = result["tool_call_id"]
                if "content" in result:
                    part["content"] = result["content"]
                else:
                    part["content"] = result
                self.parts.append(part)
            return
        if streaming:
            self.pending_text += text
        else:
            self.pending_text = text

    def add_attachment(self, part: dict[str, Any] | None) -> None:
        if not part:
            return
        self._flush_pending_text()
        self.parts.append(part)

    def build_message_parts(self) -> list[dict[str, Any]]:
        self._flush_pending_text()
        return self.parts

    def reset(self) -> None:
        self.parts = []
        self.pending_text = ""

    def _flush_pending_text(self) -> None:
        if not self.pending_text:
            return
        if self.parts and self.parts[-1].get("type") == "plain":
            previous = self.parts[-1].get("text")
            self.parts[-1]["text"] = f"{previous or ''}{self.pending_text}"
        else:
            self.parts.append({"type": "plain", "text": self.pending_text})
        self.pending_text = ""

    def _append_think(self, text: str) -> None:
        if not text:
            return
        if self.parts and self.parts[-1].get("type") == "think":
            previous = self.parts[-1].get("think")
            self.parts[-1]["think"] = f"{previous or ''}{text}"
        else:
            self.parts.append({"type": "think", "think": text})

    @staticmethod
    def _parse_json_object(text: str) -> dict[str, Any] | None:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None


class UnderstandAnythingWebChatProxy:
    def __init__(
        self,
        context: Any,
        *,
        queue_mgr: Any | None = None,
        active_event_registry: Any | None = None,
        context_store: WebChatSessionContextStore | None = None,
    ) -> None:
        self.context = context
        self._queue_mgr = queue_mgr
        self._active_event_registry = active_event_registry
        self.context_store = context_store or WebChatSessionContextStore()
        self._pending_sends: dict[str, dict[str, Any]] = {}

    async def list_sessions(
        self,
        username: str,
        *,
        page: int = 1,
        page_size: int = 100,
    ) -> dict[str, Any]:
        sessions, total = await self.db.get_platform_sessions_by_creator_paginated(
            creator=username,
            platform_id=WEBCHAT_PLATFORM_ID,
            page=page,
            page_size=page_size,
            exclude_project_sessions=True,
        )
        return {
            "sessions": [
                self._session_payload(
                    item.get("session") if isinstance(item, dict) else item
                )
                for item in sessions
            ],
            "total": total,
        }

    async def create_session(
        self,
        username: str,
        *,
        display_name: str | None = None,
        project_ref: dict[str, Any] | None = None,
        context_items: list[Any] | None = None,
    ) -> dict[str, Any]:
        session = await self.db.create_platform_session(
            creator=username,
            platform_id=WEBCHAT_PLATFORM_ID,
            display_name=display_name,
            is_group=0,
        )
        if project_ref or context_items:
            self.context_store.update(
                session_id=str(session.session_id),
                username=username,
                project_ref=project_ref,
                context_items=context_items,
            )
        return self._session_payload(session)

    async def get_session(self, username: str, session_id: str) -> dict[str, Any]:
        session = await self._owned_session(username, session_id)
        history = await self.history_mgr.get(
            platform_id=str(session.platform_id),
            user_id=session_id,
            page=1,
            page_size=1000,
        )
        return {
            "session": self._session_payload(session),
            "history": [_jsonable_record(item) for item in history],
            "threads": [],
            "is_running": self._is_running(session_id),
            "ua_context": self.context_store.context_for_session(session_id),
        }

    async def rename_session(
        self,
        username: str,
        session_id: str,
        display_name: str,
    ) -> dict[str, Any]:
        if not display_name.strip():
            raise ValueError("Missing display_name.")
        await self._owned_session(username, session_id)
        await self.db.update_platform_session(
            session_id=session_id,
            display_name=display_name.strip(),
        )
        session = await self._owned_session(username, session_id)
        return self._session_payload(session)

    async def start_send(
        self,
        username: str,
        body: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = str(body.get("session_id") or "").strip()
        if not session_id:
            created = await self.create_session(
                username,
                display_name=_default_session_display_name(body.get("message")),
                project_ref=_project_ref_from_body(body),
                context_items=_context_items_from_body(body),
            )
            session_id = str(created["session_id"])
        session = await self._owned_session(username, session_id)
        message_parts = _build_user_message_parts(body.get("message"))
        if not _message_parts_have_content(message_parts):
            raise ValueError("Message content is empty.")

        request_id = str(body.get("message_id") or uuid.uuid4())
        llm_checkpoint_id = str(body.get("_llm_checkpoint_id") or uuid.uuid4())
        saved_user_record = await self.history_mgr.insert(
            platform_id=str(session.platform_id),
            user_id=session_id,
            content={"type": "user", "message": _strip_transport_paths(message_parts)},
            sender_id=username,
            sender_name=username,
            llm_checkpoint_id=llm_checkpoint_id,
        )
        project_ref = _project_ref_from_body(body)
        context_items = _context_items_from_body(body)
        if project_ref or context_items:
            self.context_store.update(
                session_id=session_id,
                username=username,
                project_ref=project_ref,
                context_items=context_items,
            )
        self.queue_mgr.get_or_create_back_queue(request_id, session_id)
        self._pending_sends[request_id] = {
            "session_id": session_id,
            "platform_id": str(session.platform_id),
            "llm_checkpoint_id": llm_checkpoint_id,
            "saved_user_record": _jsonable_record(saved_user_record),
        }
        try:
            chat_queue = self.queue_mgr.get_or_create_queue(session_id)
            await chat_queue.put(
                (
                    username,
                    session_id,
                    {
                        "message": message_parts,
                        "selected_provider": body.get("selected_provider"),
                        "selected_model": body.get("selected_model"),
                        "enable_streaming": body.get("enable_streaming", True),
                        "message_id": request_id,
                        "llm_checkpoint_id": llm_checkpoint_id,
                    },
                ),
            )
        except Exception:
            self._pending_sends.pop(request_id, None)
            self._remove_back_queue(request_id)
            raise
        return {
            "request_id": request_id,
            "message_id": request_id,
            "session_id": session_id,
            "llm_checkpoint_id": llm_checkpoint_id,
        }

    async def stream_send_events(
        self,
        username: str,
        request_id: str,
        *,
        heartbeat_seconds: float = 1.0,
    ) -> AsyncIterator[str]:
        pending = self._pending_sends.get(request_id)
        if not pending:
            yield self._sse_error("Unknown WebChat send request.")
            return
        session_id = str(pending["session_id"])
        session = await self._owned_session(username, session_id)
        back_queue = self._back_queue(request_id)
        accumulator = WebChatBotMessageAccumulator()
        agent_stats: dict[str, Any] = {}
        refs: dict[str, Any] = {}

        async def flush_pending_bot_message() -> dict[str, Any] | None:
            nonlocal agent_stats, refs
            if not (accumulator.has_content() or agent_stats or refs):
                return None
            saved = await self._save_bot_message(
                session_id=session_id,
                platform_id=str(session.platform_id),
                message_parts=accumulator.build_message_parts(),
                agent_stats=agent_stats,
                refs=refs,
                llm_checkpoint_id=str(pending["llm_checkpoint_id"]),
            )
            accumulator.reset()
            agent_stats = {}
            refs = {}
            return saved

        try:
            yield self._sse(
                {
                    "type": "session_id",
                    "data": None,
                    "session_id": session_id,
                    "message_id": request_id,
                },
            )
            saved_user_record = pending.get("saved_user_record")
            if saved_user_record:
                yield self._sse(
                    {
                        "type": "user_message_saved",
                        "data": saved_user_record,
                        "session_id": session_id,
                    },
                )
            while True:
                try:
                    result = await asyncio.wait_for(
                        back_queue.get(),
                        timeout=heartbeat_seconds,
                    )
                except asyncio.TimeoutError:
                    yield SSE_HEARTBEAT
                    continue

                if not isinstance(result, dict):
                    continue
                if result.get("message_id") and result.get("message_id") != request_id:
                    continue

                msg_type = str(result.get("type") or "")
                chain_type = result.get("chain_type")
                data = result.get("data", "")
                streaming = bool(result.get("streaming", False))

                if chain_type == "agent_stats":
                    try:
                        agent_stats = json.loads(str(data))
                    except json.JSONDecodeError:
                        agent_stats = {}
                    yield self._sse({"type": "agent_stats", "data": agent_stats})
                    continue
                if chain_type == "refs" or msg_type == "refs":
                    try:
                        refs_payload = json.loads(str(data))
                    except json.JSONDecodeError:
                        refs_payload = {}
                    refs = refs_payload if isinstance(refs_payload, dict) else {}
                    yield self._sse({"type": "refs", "data": refs})
                    continue

                if msg_type == "plain" and isinstance(data, str):
                    accumulator.add_plain(
                        data,
                        chain_type=chain_type,
                        streaming=streaming,
                    )
                elif msg_type in MEDIA_EVENT_PREFIXES and isinstance(data, str):
                    part = await self._create_attachment_from_event(msg_type, data)
                    accumulator.add_attachment(part)
                    if part and part.get("attachment_id"):
                        yield self._sse(
                            {
                                "type": "attachment_saved",
                                "data": {
                                    "id": part["attachment_id"],
                                    "type": part.get("type", msg_type),
                                },
                                "session_id": session_id,
                            },
                        )

                yield self._sse(result)

                should_save = False
                if msg_type == "end":
                    should_save = bool(accumulator.has_content() or agent_stats or refs)
                elif (streaming and msg_type == "complete") or (
                    msg_type and not streaming
                ):
                    should_save = chain_type not in {"tool_call", "tool_call_result"}

                if should_save:
                    saved = await flush_pending_bot_message()
                    if saved:
                        yield self._sse(
                            {
                                "type": "message_saved",
                                "data": saved,
                                "session_id": session_id,
                            },
                        )
                if msg_type == "end":
                    break
        finally:
            try:
                await flush_pending_bot_message()
            finally:
                self._pending_sends.pop(request_id, None)
                self._remove_back_queue(request_id)

    async def cancel_send(
        self,
        username: str,
        request_id: str,
        *,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        pending = self._pending_sends.pop(request_id, None)
        target_session_id = str(
            session_id or (pending or {}).get("session_id") or "",
        ).strip()
        stopped_count = 0
        if target_session_id:
            stopped = await self.stop_session(username, target_session_id)
            stopped_count = int(stopped.get("stopped_count") or 0)
        self._remove_back_queue(request_id)
        return {
            "cancelled": bool(pending or request_id),
            "session_id": target_session_id,
            "stopped_count": stopped_count,
        }

    async def stop_session(self, username: str, session_id: str) -> dict[str, Any]:
        session = await self._owned_session(username, session_id)
        umo = build_webchat_unified_msg_origin(
            username,
            session_id,
            platform_id=str(session.platform_id),
            is_group=bool(getattr(session, "is_group", 0)),
        )
        request_stop = getattr(
            self.active_event_registry, "request_agent_stop_all", None
        )
        stopped_count = request_stop(umo) if callable(request_stop) else 0
        return {"stopped_count": stopped_count}

    @property
    def queue_mgr(self) -> Any:
        if self._queue_mgr is None:
            self._queue_mgr = _default_queue_mgr()
        return self._queue_mgr

    @property
    def active_event_registry(self) -> Any:
        if self._active_event_registry is None:
            self._active_event_registry = _default_active_event_registry()
        return self._active_event_registry

    @property
    def db(self) -> Any:
        get_db = getattr(self.context, "get_db", None)
        if callable(get_db):
            return get_db()
        db = getattr(self.context, "db", None) or getattr(self.context, "_db", None)
        if db is not None:
            return db
        raise RuntimeError("AstrBot database is unavailable.")

    @property
    def history_mgr(self) -> Any:
        history_mgr = getattr(self.context, "message_history_manager", None)
        if history_mgr is not None:
            return history_mgr
        raise RuntimeError("AstrBot message history manager is unavailable.")

    async def _owned_session(self, username: str, session_id: str) -> Any:
        if not session_id:
            raise ValueError("Missing session_id.")
        session = await self.db.get_platform_session_by_id(session_id)
        if session is None:
            raise ValueError(f"Session {session_id} not found.")
        if getattr(session, "creator", None) != username:
            raise PermissionError("Permission denied.")
        return session

    def _back_queue(self, request_id: str) -> asyncio.Queue:
        queues = getattr(self.queue_mgr, "back_queues", None)
        if isinstance(queues, dict) and request_id in queues:
            return queues[request_id]
        get_queue = getattr(self.queue_mgr, "get_or_create_back_queue", None)
        if callable(get_queue):
            return get_queue(request_id)
        raise RuntimeError("AstrBot WebChat back queue is unavailable.")

    def _is_running(self, session_id: str) -> bool:
        list_ids = getattr(self.queue_mgr, "list_back_request_ids", None)
        if callable(list_ids):
            return bool(list_ids(session_id))
        return False

    def _remove_back_queue(self, request_id: str) -> None:
        remove_back_queue = getattr(self.queue_mgr, "remove_back_queue", None)
        if callable(remove_back_queue):
            remove_back_queue(request_id)

    async def _save_bot_message(
        self,
        *,
        session_id: str,
        platform_id: str,
        message_parts: list[dict[str, Any]],
        agent_stats: dict[str, Any],
        refs: dict[str, Any],
        llm_checkpoint_id: str,
    ) -> dict[str, Any] | None:
        content: dict[str, Any] = {"type": "bot", "message": message_parts}
        if agent_stats:
            content["agent_stats"] = agent_stats
        if refs:
            content["refs"] = refs
        if not content["message"] and not agent_stats and not refs:
            return None
        record = await self.history_mgr.insert(
            platform_id=platform_id,
            user_id=session_id,
            content=content,
            sender_id="bot",
            sender_name="bot",
            llm_checkpoint_id=llm_checkpoint_id,
        )
        return _jsonable_record(record)

    async def _create_attachment_from_event(
        self,
        msg_type: str,
        data: str,
    ) -> dict[str, Any] | None:
        prefix = MEDIA_EVENT_PREFIXES.get(msg_type, "")
        filename = data.replace(prefix, "", 1).strip() if prefix else data.strip()
        if not filename:
            return None
        helper = _create_attachment_part_from_existing_file()
        if helper is not None and hasattr(self.db, "insert_attachment"):
            part = await helper(
                filename,
                attach_type=msg_type,
                insert_attachment=self.db.insert_attachment,
                attachments_dir=self._attachments_dir(),
            )
            if part:
                return dict(part)
        basename = Path(filename).name
        candidate = self._attachments_dir() / basename
        if candidate.exists() and hasattr(self.db, "insert_attachment"):
            mime_type, _ = mimetypes.guess_type(str(candidate))
            attachment = await self.db.insert_attachment(
                str(candidate),
                msg_type,
                mime_type or "application/octet-stream",
            )
            if attachment:
                return {
                    "type": msg_type,
                    "attachment_id": getattr(attachment, "attachment_id", ""),
                    "filename": basename,
                }
        return {"type": msg_type, "filename": basename}

    def _attachments_dir(self) -> Path:
        configured = getattr(self.context, "attachments_dir", None)
        if configured:
            return Path(configured)
        try:
            from astrbot.core.utils.astrbot_path import get_astrbot_data_path

            return Path(get_astrbot_data_path()) / "attachments"
        except Exception:
            return PLUGIN_ROOT / ".plugin_data" / "attachments"

    @staticmethod
    def _sse(payload: dict[str, Any]) -> str:
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    @staticmethod
    def _sse_error(message: str) -> str:
        return UnderstandAnythingWebChatProxy._sse(
            {"type": "error", "data": message},
        )

    @staticmethod
    def _session_payload(session: Any) -> dict[str, Any]:
        return {
            "session_id": str(getattr(session, "session_id", "")),
            "platform_id": str(getattr(session, "platform_id", WEBCHAT_PLATFORM_ID)),
            "creator": str(getattr(session, "creator", "")),
            "display_name": getattr(session, "display_name", None),
            "is_group": int(getattr(session, "is_group", 0) or 0),
            "created_at": _jsonable_value(getattr(session, "created_at", None)),
            "updated_at": _jsonable_value(getattr(session, "updated_at", None)),
        }


def _default_context_path() -> Path:
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

        return (
            Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "webchat-contexts.json"
        )
    except Exception:
        return PLUGIN_ROOT / ".plugin_data" / "webchat-contexts.json"


def _default_queue_mgr() -> Any:
    from astrbot.core.platform.sources.webchat.webchat_queue_mgr import (
        webchat_queue_mgr,
    )

    return webchat_queue_mgr


def _default_active_event_registry() -> Any:
    from astrbot.core.utils.active_event_registry import active_event_registry

    return active_event_registry


def _create_attachment_part_from_existing_file() -> Any | None:
    try:
        from astrbot.core.platform.sources.webchat.message_parts_helper import (
            create_attachment_part_from_existing_file,
        )

        return create_attachment_part_from_existing_file
    except Exception:
        return None


def _strip_message_parts_path_fields() -> Any | None:
    try:
        from astrbot.core.platform.sources.webchat.message_parts_helper import (
            strip_message_parts_path_fields,
        )

        return strip_message_parts_path_fields
    except Exception:
        return None


def _webchat_message_parts_have_content() -> Any | None:
    try:
        from astrbot.core.platform.sources.webchat.message_parts_helper import (
            webchat_message_parts_have_content,
        )

        return webchat_message_parts_have_content
    except Exception:
        return None


def _clean_project_ref(project_ref: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key in ("project_id", "project_name", "project_path", "project_ref", "project"):
        value = project_ref.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()
    return clean


def _project_ref_from_body(body: dict[str, Any]) -> dict[str, Any]:
    return _clean_project_ref(
        {
            "project_id": body.get("project_id"),
            "project_name": body.get("project_name"),
            "project_path": body.get("project_path") or body.get("path"),
            "project_ref": body.get("project_ref"),
            "project": body.get("project"),
        },
    )


def _context_items_from_body(body: dict[str, Any]) -> list[Any]:
    items = body.get("contextItems")
    if items is None:
        items = body.get("context_items")
    return items if isinstance(items, list) else []


def _default_session_display_name(message: Any) -> str | None:
    if not isinstance(message, str):
        return None
    text = message.strip().replace("\n", " ")
    return text[:32] or None


def _build_user_message_parts(message: Any) -> list[dict[str, Any]]:
    if isinstance(message, str):
        text = message.strip()
        return [{"type": "plain", "text": text}] if text else []
    if isinstance(message, dict):
        return [dict(message)]
    if isinstance(message, list):
        return [dict(part) for part in message if isinstance(part, dict)]
    return []


def _message_parts_have_content(parts: list[dict[str, Any]]) -> bool:
    helper = _webchat_message_parts_have_content()
    if helper is not None:
        try:
            return bool(helper(parts))
        except Exception:
            pass
    for part in parts:
        if part.get("type") == "plain" and str(part.get("text") or "").strip():
            return True
        if part.get("type") != "plain" and len(part) > 1:
            return True
    return False


def _strip_transport_paths(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    helper = _strip_message_parts_path_fields()
    if helper is not None:
        try:
            stripped = helper(parts)
            if isinstance(stripped, list):
                return stripped
        except Exception:
            pass
    output: list[dict[str, Any]] = []
    for part in parts:
        copied = dict(part)
        copied.pop("path", None)
        output.append(copied)
    return output


def _jsonable_record(record: Any) -> dict[str, Any]:
    if hasattr(record, "model_dump"):
        raw = record.model_dump()
    elif isinstance(record, dict):
        raw = record
    else:
        raw = {
            key: value for key, value in vars(record).items() if not key.startswith("_")
        }
    return {str(key): _jsonable_value(value) for key, value in raw.items()}


def _jsonable_value(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _jsonable_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable_value(item) for item in value]
    return value
