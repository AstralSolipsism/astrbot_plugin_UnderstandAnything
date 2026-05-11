from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from quart import Response as QuartResponse
from quart import jsonify, request

from astrbot.core.star import Context

from .constants import (
    DASHBOARD_PAGE_ROOT,
    DASHBOARD_SOURCE_ROOT,
    GRAPH_FILES,
    PLUGIN_DISPLAY_NAME,
    PLUGIN_NAME,
    UNDERSTAND_ANYTHING_ROOT,
)
from .job_store import JobStatus
from .path_security import PathSecurityError
from .runner import UnderstandAnythingRunner

WebHandler = Callable[[], Awaitable[Any]]


class UnderstandAnythingWebApi:
    def __init__(self, context: Context, runner: UnderstandAnythingRunner) -> None:
        self.context = context
        self.runner = runner

    def register(self) -> None:
        for route, handler, methods, desc in self.routes():
            self.context.register_web_api(route, handler, methods, desc)

    def routes(self) -> list[tuple[str, WebHandler, list[str], str]]:
        prefix = f"/{PLUGIN_NAME}"
        return [
            (f"{prefix}/status", self.status, ["GET"], "Read plugin status"),
            (f"{prefix}/projects", self.projects, ["GET"], "List registered projects"),
            (f"{prefix}/graph", self.graph, ["GET"], "Read knowledge graph"),
            (f"{prefix}/meta", self.meta, ["GET"], "Read analysis metadata"),
            (
                f"{prefix}/domain-graph",
                self.domain_graph,
                ["GET"],
                "Read domain graph",
            ),
            (
                f"{prefix}/diff-overlay",
                self.diff_overlay,
                ["GET"],
                "Read diff overlay",
            ),
            (
                f"{prefix}/file-content",
                self.file_content,
                ["GET"],
                "Read graph source file",
            ),
            (f"{prefix}/jobs/start", self.start_job, ["POST"], "Start job"),
            (f"{prefix}/jobs/<job_id>", self.get_job, ["GET"], "Get job"),
            (
                f"{prefix}/jobs/<job_id>/events",
                self.job_events,
                ["GET"],
                "Subscribe job events",
            ),
            (f"{prefix}/chat", self.chat, ["POST"], "Chat with graph"),
            (f"{prefix}/explain", self.explain, ["POST"], "Explain graph node"),
            (f"{prefix}/diff", self.diff, ["POST"], "Analyze diff"),
            (f"{prefix}/onboard", self.onboard, ["POST"], "Generate onboarding"),
            (f"{prefix}/domain", self.start_job, ["POST"], "Start domain job"),
            (f"{prefix}/knowledge", self.start_job, ["POST"], "Start knowledge job"),
        ]

    async def graph(self):
        return await self._json_file("graph")

    async def meta(self):
        return await self._json_file("meta")

    async def domain_graph(self):
        return await self._json_file("domain-graph")

    async def diff_overlay(self):
        return await self._json_file("diff-overlay")

    async def status(self):
        return jsonify({"status": "ok", "data": self.status_payload()})

    def status_payload(self) -> dict[str, Any]:
        config = getattr(self.runner, "config", {}) or {}
        security = getattr(self.runner, "security", None)
        allowed_roots = [
            str(root)
            for root in getattr(security, "allowed_roots", [])
            if str(root)
        ]
        return {
            "plugin": {
                "name": PLUGIN_NAME,
                "display_name": PLUGIN_DISPLAY_NAME,
            },
            "config": {
                "provider_configured": bool(config.get("provider_id")),
                "node_bin": str(config.get("node_bin") or "node"),
                "pnpm_bin": str(config.get("pnpm_bin") or "pnpm"),
                "auto_build": bool(config.get("auto_build", True)),
                "auto_update_poll_interval": int(
                    config.get("auto_update_poll_interval") or 0,
                ),
                "max_concurrent_jobs": int(config.get("max_concurrent_jobs") or 1),
                "allowed_roots": allowed_roots,
                "default_write_mode": str(
                    config.get("default_write_mode") or "project",
                ),
            },
            "runtime": {
                "understand_anything_root": self._path_state(
                    UNDERSTAND_ANYTHING_ROOT,
                ),
                "runtime_dist": self._path_state(
                    UNDERSTAND_ANYTHING_ROOT / "dist" / "index.js",
                ),
                "core_dist": self._path_state(
                    UNDERSTAND_ANYTHING_ROOT / "packages" / "core" / "dist" / "index.js",
                ),
                "dashboard_dist": self._path_state(
                    DASHBOARD_SOURCE_ROOT / "dist" / "index.html",
                ),
                "dashboard_page": self._path_state(DASHBOARD_PAGE_ROOT / "index.html"),
                "node_modules": self._path_state(
                    UNDERSTAND_ANYTHING_ROOT / "node_modules",
                ),
            },
        }

    async def projects(self):
        return jsonify(
            {
                "status": "ok",
                "data": {
                    "projects": [
                        record.to_dict() for record in self.runner.registry.list()
                    ]
                },
            }
        )

    async def file_content(self):
        try:
            store = self.runner.project_store(
                **self._query_project_ref(allow_path_alias=False)
            )
            return jsonify(
                {
                    "status": "ok",
                    "data": store.read_source_file(self._query("path")),
                }
            )
        except Exception as exc:
            return self._error(exc)

    async def start_job(self):
        try:
            body = await self._json_body()
            action = str(body.get("action") or self._route_action()).strip()
            if action not in {
                "understand",
                "understand-dashboard",
                "understand-diff",
                "understand-domain",
                "understand-knowledge",
                "understand-onboard",
            }:
                raise ValueError(f"Unsupported async job action: {action}")
            explicit_args = body.get("raw_args") or body.get("arguments")
            if isinstance(explicit_args, str) and explicit_args.strip():
                job = await self.runner.start_skill_job(
                    skill_name=action,
                    raw_args=explicit_args.strip(),
                    event=None,
                )
            else:
                job = await self.runner.start_skill_job(
                    skill_name=action,
                    event=None,
                    flags=self._job_flags(body),
                    **self._body_project_ref(body),
                )
            return jsonify({"status": "ok", "data": job.to_dict()})
        except Exception as exc:
            return self._error(exc)

    async def get_job(self, job_id: str):
        job = self.runner.jobs.get(job_id)
        if job is None:
            return jsonify({"status": "error", "message": "Job not found"}), 404
        return jsonify({"status": "ok", "data": job.to_dict()})

    async def job_events(self, job_id: str):
        job = self.runner.jobs.get(job_id)
        if job is None:
            return jsonify({"status": "error", "message": "Job not found"}), 404

        async def stream():
            last_updated_at = -1.0
            while True:
                current = self.runner.jobs.get(job_id)
                if current is None:
                    yield 'event: error\ndata: {"message":"Job not found"}\n\n'
                    return
                if current.updated_at != last_updated_at:
                    last_updated_at = current.updated_at
                    payload = json.dumps(current.to_dict(), ensure_ascii=False)
                    yield f"data: {payload}\n\n"
                if current.status in {
                    JobStatus.FINISHED,
                    JobStatus.FAILED,
                    JobStatus.CANCELLED,
                }:
                    return
                await asyncio.sleep(1)

        return QuartResponse(stream(), content_type="text/event-stream")

    async def chat(self):
        try:
            body = await self._json_body()
            answer = await self.runner.chat(
                query=str(body.get("query") or ""),
                **self._body_project_ref(body),
            )
            return jsonify({"status": "ok", "data": {"answer": answer}})
        except Exception as exc:
            return self._error(exc)

    async def explain(self):
        try:
            body = await self._json_body()
            answer = await self.runner.explain(
                target=str(body.get("target") or body.get("path") or ""),
                **self._body_project_ref(body, allow_path_alias=False),
            )
            return jsonify({"status": "ok", "data": {"answer": answer}})
        except Exception as exc:
            return self._error(exc)

    async def diff(self):
        try:
            body = await self._json_body()
            answer = await self.runner.diff(
                changed_files=[
                    str(item)
                    for item in body.get("changed_files", [])
                    if isinstance(item, str)
                ]
                or None,
                **self._body_project_ref(body),
            )
            return jsonify({"status": "ok", "data": {"answer": answer}})
        except Exception as exc:
            return self._error(exc)

    async def onboard(self):
        try:
            body = await self._json_body()
            markdown = await self.runner.onboard(
                **self._body_project_ref(body),
            )
            return jsonify({"status": "ok", "data": {"markdown": markdown}})
        except Exception as exc:
            return self._error(exc)

    async def _json_file(self, key: str):
        try:
            store = self.runner.project_store(**self._query_project_ref())
            payload = store.read_json(GRAPH_FILES[key])
            return jsonify({"status": "ok", "data": payload})
        except FileNotFoundError:
            return jsonify({"status": "error", "message": "File not found"}), 404
        except Exception as exc:
            return self._error(exc)

    async def _json_body(self) -> dict[str, Any]:
        body = await request.get_json(silent=True)
        return body if isinstance(body, dict) else {}

    def _query_project_ref(self, *, allow_path_alias: bool = True) -> dict[str, Any]:
        project_path = request.args.get("project_path")
        if project_path is None and allow_path_alias:
            project_path = request.args.get("path")
        return {
            "project_id": request.args.get("project_id"),
            "project_name": request.args.get("project_name"),
            "project_path": project_path,
            "project_ref": request.args.get("project"),
        }

    @staticmethod
    def _query(name: str) -> str:
        value = request.args.get(name, "")
        if not value:
            raise ValueError(f"Missing query parameter: {name}")
        return value

    @staticmethod
    def _route_action() -> str:
        path = request.path.rstrip("/").split("/")[-1]
        return {
            "domain": "understand-domain",
            "knowledge": "understand-knowledge",
        }.get(path, "understand")

    @staticmethod
    def _body_project_ref(
        body: dict[str, Any],
        *,
        allow_path_alias: bool = True,
    ) -> dict[str, Any]:
        project_path = body.get("project_path")
        if project_path is None and allow_path_alias:
            project_path = body.get("path")
        return {
            "project_id": body.get("project_id"),
            "project_name": body.get("project_name"),
            "project_path": project_path,
            "project_ref": body.get("project") or body.get("project_ref"),
        }

    @staticmethod
    def _job_flags(body: dict[str, Any]) -> list[str]:
        flags: list[str] = []
        if body.get("full"):
            flags.append("--full")
        if body.get("review"):
            flags.append("--review")
        if body.get("auto_update") is True:
            flags.append("--auto-update")
        if body.get("auto_update") is False:
            flags.append("--no-auto-update")
        return flags

    @staticmethod
    def _path_state(path):
        return {
            "path": str(path),
            "exists": path.exists(),
            "is_dir": path.is_dir(),
        }

    @staticmethod
    def _error(exc: Exception):
        status_code = 400 if isinstance(exc, (ValueError, PathSecurityError)) else 500
        return jsonify({"status": "error", "message": str(exc)}), status_code
