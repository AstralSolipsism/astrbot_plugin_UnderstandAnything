from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from quart import Response as QuartResponse
from quart import jsonify, request

from astrbot.core.star import Context
from astrbot.core.utils.llm_metadata import LLM_METADATAS

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
from .subagent_registry import UnderstandAnythingSubAgentRegistry

WebHandler = Callable[[], Awaitable[Any]]


class UnderstandAnythingWebApi:
    def __init__(self, context: Context, runner: UnderstandAnythingRunner) -> None:
        self.context = context
        self.runner = runner
        self.subagent_registry = UnderstandAnythingSubAgentRegistry(
            context,
            getattr(runner, "config", {}) or {},
        )

    def register(self) -> None:
        for route, handler, methods, desc in self.routes():
            self.context.register_web_api(route, handler, methods, desc)

    def routes(self) -> list[tuple[str, WebHandler, list[str], str]]:
        prefix = f"/{PLUGIN_NAME}"
        return [
            (f"{prefix}/status", self.status, ["GET"], "Read plugin status"),
            (
                f"{prefix}/subagents/status",
                self.subagents_status,
                ["GET"],
                "Read UA SubAgent registration status",
            ),
            (
                f"{prefix}/subagents/register",
                self.register_subagents,
                ["POST"],
                "Register UA SubAgents in AstrBot config",
            ),
            (
                f"{prefix}/subagents/providers",
                self.subagent_providers,
                ["GET"],
                "List chat providers for UA SubAgent registration",
            ),
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
                "subagent_provider_configured": bool(
                    config.get("subagent_provider_id"),
                ),
                "node_bin": str(config.get("node_bin") or "node"),
                "pnpm_bin": str(config.get("pnpm_bin") or "pnpm"),
                "git_bin": str(config.get("git_bin") or "git"),
                "git_available": self._git_available(),
                "github_cache_root": self._github_cache_root(),
                "github_artifact_root": self._github_artifact_root(),
                "cleanup_github_cache_after_analysis": bool(
                    config.get("cleanup_github_cache_after_analysis", False),
                ),
                "auto_build": bool(config.get("auto_build", True)),
                "auto_update_poll_interval": self._int_config(
                    config.get("auto_update_poll_interval"),
                    0,
                ),
                "max_concurrent_jobs": self._int_config(
                    config.get("max_concurrent_jobs"),
                    1,
                ),
                "max_parallel_file_agents": self._int_config(
                    config.get("max_parallel_file_agents"),
                    5,
                ),
                "max_parallel_article_agents": self._int_config(
                    config.get("max_parallel_article_agents"),
                    3,
                ),
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
                "github_cache_root": self._path_state(
                    getattr(getattr(self.runner, "github", None), "cache_root", None),
                ),
                "github_artifact_root": self._path_state(
                    getattr(getattr(self.runner, "github", None), "artifact_root", None),
                ),
            },
            "subagents": self.subagent_registry.status_payload(),
            "subagent_provider_options": self._provider_options_payload(),
        }

    async def subagents_status(self):
        return jsonify(
            {"status": "ok", "data": self.subagent_registry.status_payload()}
        )

    async def register_subagents(self):
        try:
            body = await self._json_body()
            payload = await self.subagent_registry.register_required_subagents(
                provider_id=self._string_or_none(body.get("provider_id")),
                provider_id_provided="provider_id" in body,
            )
            return jsonify({"status": "ok", "data": payload})
        except Exception as exc:
            return self._error(exc)

    async def subagent_providers(self):
        try:
            return jsonify({"status": "ok", "data": self._provider_options_payload()})
        except Exception as exc:
            return self._error(exc)

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
            project_ref = self._query_project_ref(allow_path_alias=False)
            if not project_ref.get("project_path"):
                await self.runner.ensure_project_source_ready(
                    project_id=project_ref.get("project_id"),
                    project_name=project_ref.get("project_name"),
                    project_ref=project_ref.get("project_ref"),
                )
            store = self.runner.project_store(**project_ref)
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
                target = self._string_or_none(body.get("target"))
                project_ref = self._body_project_ref(body)
                if target:
                    if self.runner.github.is_http_url(target):
                        repo_url = target
                        project_ref["project_path"] = None
                    else:
                        repo_url = None
                        project_ref["project_path"] = target
                else:
                    repo_url = self._string_or_none(body.get("repo_url"))
                job = await self.runner.start_skill_job(
                    skill_name=action,
                    event=None,
                    flags=self._job_flags(body),
                    repo_url=repo_url,
                    ref=self._string_or_none(body.get("ref")),
                    **project_ref,
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
        if path is None:
            return {
                "path": "",
                "exists": False,
                "is_dir": False,
            }
        return {
            "path": str(path),
            "exists": path.exists(),
            "is_dir": path.is_dir(),
        }

    def _git_available(self) -> bool:
        github = getattr(self.runner, "github", None)
        if github and hasattr(github, "git_available"):
            return bool(github.git_available())
        return False

    def _github_cache_root(self) -> str:
        github = getattr(self.runner, "github", None)
        return str(getattr(github, "cache_root", "") or "")

    def _github_artifact_root(self) -> str:
        github = getattr(self.runner, "github", None)
        return str(getattr(github, "artifact_root", "") or "")

    def _provider_options_payload(self) -> dict[str, Any]:
        providers = self._chat_provider_summaries()
        recommended = self.subagent_registry.desired_provider_id()
        provider_ids = {item["id"] for item in providers}
        if recommended and recommended not in provider_ids:
            recommended = None
        if not recommended and self.context is not None:
            get_using_provider = getattr(self.context, "get_using_provider", None)
            if callable(get_using_provider):
                current_provider = get_using_provider()
                recommended = self._provider_id(current_provider)
                if recommended not in provider_ids:
                    recommended = None
        if not recommended and providers:
            recommended = providers[0]["id"]
        return {
            "providers": providers,
            "recommended_provider_id": recommended or "",
        }

    def _chat_provider_summaries(self) -> list[dict[str, Any]]:
        if self.context is None:
            return []
        providers: list[dict[str, Any]] = []
        seen: set[str] = set()
        get_all_providers = getattr(self.context, "get_all_providers", None)
        if callable(get_all_providers):
            for provider in get_all_providers() or []:
                summary = self._provider_summary_from_instance(provider)
                if not summary:
                    continue
                seen.add(summary["id"])
                providers.append(summary)

        provider_manager = getattr(self.context, "provider_manager", None)
        if provider_manager is None:
            return providers

        sources = {
            str(item.get("id", "")): str(
                item.get("provider_type") or "chat_completion",
            )
            for item in getattr(provider_manager, "provider_sources_config", []) or []
            if isinstance(item, dict)
        }
        for provider_config in getattr(provider_manager, "providers_config", []) or []:
            if not isinstance(provider_config, dict):
                continue
            provider_id = str(provider_config.get("id") or "").strip()
            if not provider_id or provider_id in seen:
                continue
            source_id = provider_config.get("provider_source_id")
            source_type = sources.get(str(source_id or "")) if source_id else None
            provider_type = source_type or str(
                provider_config.get("provider_type") or "",
            )
            if provider_type != "chat_completion":
                continue
            get_merged = getattr(provider_manager, "get_merged_provider_config", None)
            merged = (
                get_merged(provider_config)
                if callable(get_merged)
                else dict(provider_config)
            )
            summary = self._provider_summary_from_config(merged)
            if summary:
                seen.add(summary["id"])
                providers.append(summary)
        return providers

    @classmethod
    def _provider_summary_from_instance(cls, provider: Any) -> dict[str, Any] | None:
        provider_id = cls._provider_id(provider)
        if not provider_id:
            return None
        config = getattr(provider, "provider_config", None)
        config = config if isinstance(config, dict) else {}
        meta = cls._provider_meta(provider)
        model = str(getattr(meta, "model", "") or config.get("model") or "").strip()
        provider_type = cls._enum_value(getattr(meta, "provider_type", None))
        return {
            "id": provider_id,
            "model": model,
            "type": str(getattr(meta, "type", "") or config.get("type") or ""),
            "provider_type": provider_type or "chat_completion",
            "enable": bool(config.get("enable", True)),
            "model_metadata": cls._model_metadata(model),
        }

    @classmethod
    def _provider_summary_from_config(cls, config: dict[str, Any]) -> dict[str, Any] | None:
        provider_id = str(config.get("id") or "").strip()
        if not provider_id:
            return None
        model = str(config.get("model") or "").strip()
        return {
            "id": provider_id,
            "model": model,
            "type": str(config.get("type") or ""),
            "provider_type": str(config.get("provider_type") or "chat_completion"),
            "enable": bool(config.get("enable", True)),
            "model_metadata": cls._model_metadata(model),
        }

    @staticmethod
    def _provider_meta(provider: Any) -> Any:
        meta = getattr(provider, "meta", None)
        if callable(meta):
            try:
                return meta()
            except Exception:
                return None
        return None

    @classmethod
    def _provider_id(cls, provider: Any) -> str | None:
        if provider is None:
            return None
        meta = cls._provider_meta(provider)
        provider_id = str(getattr(meta, "id", "") or "").strip()
        if provider_id:
            return provider_id
        config = getattr(provider, "provider_config", None)
        if isinstance(config, dict):
            provider_id = str(config.get("id") or "").strip()
            return provider_id or None
        return None

    @staticmethod
    def _enum_value(value: Any) -> str:
        enum_value = getattr(value, "value", None)
        return str(enum_value or value or "")

    @staticmethod
    def _model_metadata(model: str) -> dict[str, Any]:
        if not model:
            return {}
        metadata = LLM_METADATAS.get(model)
        return metadata if isinstance(metadata, dict) else {}

    @staticmethod
    def _string_or_none(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _int_config(value: Any, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _error(exc: Exception):
        status_code = 400 if isinstance(exc, (ValueError, PathSecurityError)) else 500
        return jsonify({"status": "error", "message": str(exc)}), status_code
