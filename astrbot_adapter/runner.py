from __future__ import annotations

import asyncio
import json
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.core.message.components import Plain
from astrbot.core.platform.astrbot_message import AstrBotMessage, MessageMember
from astrbot.core.platform.message_type import MessageType
from astrbot.core.platform.platform_metadata import PlatformMetadata
from astrbot.core.star import Context

from .constants import (
    AGENT_PROMPTS_ROOT,
    PLUGIN_NAME,
    PLUGIN_SKILLS_ROOT,
    SKILL_COMMANDS,
)
from .job_request import format_job_args, parse_job_args, split_args
from .job_store import JobSnapshot, JobStore
from .llm_dispatcher import LLMDispatcher, read_prompt_file
from .path_security import PathSecurity
from .project_registry import ProjectRegistry
from .project_store import ProjectStore
from .runtime import UnderstandAnythingRuntime


class UnderstandAnythingRunner:
    def __init__(
        self,
        context: Context,
        config: dict[str, Any] | None = None,
        registry_path: str | Path | None = None,
    ) -> None:
        self.context = context
        self.config = config or {}
        allowed_roots = self.config.get("allowed_roots") or []
        if isinstance(allowed_roots, str):
            allowed_roots = [allowed_roots]
        self.security = PathSecurity(allowed_roots)
        self.jobs = JobStore()
        self.runtime = UnderstandAnythingRuntime(
            node_bin=str(self.config.get("node_bin") or "node"),
            pnpm_bin=str(self.config.get("pnpm_bin") or "pnpm"),
            auto_build=bool(self.config.get("auto_build", True)),
        )
        self.dispatcher = LLMDispatcher(
            context,
            str(self.config.get("provider_id") or ""),
        )
        try:
            max_concurrent_jobs = int(self.config.get("max_concurrent_jobs") or 1)
        except (TypeError, ValueError):
            max_concurrent_jobs = 1
        self._job_semaphore = asyncio.Semaphore(max(1, max_concurrent_jobs))
        self._tasks: dict[str, asyncio.Task] = {}
        self._auto_update_task: asyncio.Task | None = None
        self._auto_update_projects: set[Path] = set()
        self.registry = ProjectRegistry(Path(registry_path) if registry_path else None)

    async def initialize(self) -> None:
        try:
            interval = int(self.config.get("auto_update_poll_interval") or 0)
        except (TypeError, ValueError):
            interval = 0
        if interval > 0:
            self._discover_auto_update_projects()
            self._auto_update_task = asyncio.create_task(
                self._auto_update_loop(interval),
            )

    async def terminate(self) -> None:
        if self._auto_update_task and not self._auto_update_task.done():
            self._auto_update_task.cancel()
        for task in self._tasks.values():
            if not task.done():
                task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    def project_store(
        self,
        project_path: str | Path | None = None,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> ProjectStore:
        return ProjectStore(
            self.resolve_project_root(
                project_path=project_path,
                project_id=project_id,
                project_name=project_name,
                project_ref=project_ref,
            )
        )

    def resolve_project_root(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> Path:
        return self.registry.resolve(
            self.security,
            project_id=project_id,
            project_name=project_name,
            project_path=project_path,
            project_ref=project_ref,
        )

    async def start_skill_job(
        self,
        *,
        skill_name: str,
        raw_args: str = "",
        event: AstrMessageEvent | None = None,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        flags: Sequence[str] | None = None,
        start_task: bool = True,
    ) -> JobSnapshot:
        parsed = parse_job_args(raw_args)
        selected_flags = list(flags) if flags is not None else parsed.flags
        project_root = self._resolve_job_project_root(
            raw_args=raw_args,
            parsed_path=parsed.path,
            project_path=project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref or parsed.project_ref,
        )
        display_args = raw_args.strip() or format_job_args(project_root, selected_flags)
        job = self.jobs.create(
            skill_name,
            project_root,
            {
                "raw_args": display_args,
                "project_path": str(project_root),
                "project_id": ProjectRegistry.project_id_for(project_root),
                "flags": selected_flags,
            },
        )
        auto_update = self._track_project_from_flags(project_root, selected_flags)
        self.registry.register(
            project_root,
            job_id=job.job_id,
            auto_update=auto_update,
        )
        if start_task:
            task = asyncio.create_task(self._run_skill_job(job, event))
            self._tasks[job.job_id] = task
        return job

    async def chat(
        self,
        *,
        query: str,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action(
            "chat_prompt",
            {"graph": graph, "query": query},
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Answer using the provided Understand Anything graph context.",
        )

    async def explain(
        self,
        *,
        target: str,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        event: AstrMessageEvent | None = None,
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action(
            "explain_prompt",
            {"graph": graph, "path": target},
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Explain the requested component from the graph context.",
        )

    async def diff(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
        changed_files: list[str] | None = None,
        event: AstrMessageEvent | None = None,
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        files = changed_files or self._git_changed_files(store.project_root)
        payload = await self.runtime.run_action(
            "diff_markdown",
            {"graph": graph, "changedFiles": files},
        )
        store.write_json(
            "diff-overlay.json",
            {
                "changedNodeIds": payload.get("changedNodeIds", []),
                "affectedNodeIds": payload.get("affectedNodeIds", []),
                "unmappedFiles": payload.get("unmappedFiles", []),
            },
        )
        return await self.dispatcher.generate(
            prompt=payload["markdown"],
            event=event,
            system_prompt="Analyze diff impact and risks from the graph context.",
        )

    async def onboard(
        self,
        *,
        project_path: str | Path | None = None,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> str:
        store = self.project_store(
            project_path,
            project_id=project_id,
            project_name=project_name,
            project_ref=project_ref,
        )
        graph = store.read_json("knowledge-graph.json")
        payload = await self.runtime.run_action("onboard_markdown", {"graph": graph})
        return str(payload["markdown"])

    async def _run_skill_job(
        self,
        job: JobSnapshot,
        event: AstrMessageEvent | None,
    ) -> None:
        agent_event = event or self._synthetic_event(job)
        try:
            async with self._job_semaphore:
                self.jobs.mark_running(job.job_id)
                self.jobs.append_log(
                    job.job_id,
                    f"Starting {job.kind} for {job.project_root}",
                )
                prompt = self._build_skill_execution_prompt(job)
                result = await self.dispatcher.run_with_local_tools(
                    event=agent_event,
                    prompt=prompt,
                    system_prompt=(
                        "You are the AstrBot host adapter for Understand Anything. "
                        "Execute the bundled Understand Anything skill faithfully "
                        "with local tools. "
                        "Do not modify AstrBot source files or plugin runtime source. "
                        "Only write analysis outputs under the target project's "
                        ".understand-anything directory."
                    ),
                    max_steps=120,
                )
                self.jobs.append_log(job.job_id, "Agent workflow finished.")
                self.jobs.mark_finished(job.job_id, {"message": result})
                self.registry.register(job.project_root, job_id=job.job_id)
                if event is not None:
                    await event.send(
                        MessageChain().message(
                            f"Understand Anything job finished: {job.kind}\n{result}",
                        ),
                    )
        except asyncio.CancelledError:
            self.jobs.mark_failed(job.job_id, "Job cancelled.")
            raise
        except Exception as exc:
            logger.error("Understand Anything job failed: %s", exc)
            self.jobs.mark_failed(job.job_id, str(exc))
            if event is not None:
                await event.send(
                    MessageChain().message(
                        f"Understand Anything job failed: {job.kind}\n{exc}",
                    ),
                )

    def _build_skill_execution_prompt(self, job: JobSnapshot) -> str:
        skill_dir = PLUGIN_SKILLS_ROOT / job.kind
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            raise FileNotFoundError(f"Bundled Understand Anything skill not found: {skill_md}")

        agent_files = sorted(AGENT_PROMPTS_ROOT.glob("*.md"))
        agent_index = "\n".join(f"- {path.name}: {path}" for path in agent_files)
        command_name = SKILL_COMMANDS.get(job.kind, job.kind)
        return (
            f"Execute Understand Anything command `/{command_name}` with arguments:\n"
            f"{job.args.get('raw_args', '')}\n\n"
            f"Target project root:\n{job.project_root}\n\n"
            "Bundled Understand Anything skill instructions:\n"
            "```markdown\n"
            f"{read_prompt_file(skill_md)}\n"
            "```\n\n"
            "Available AstrBot agent prompt files:\n"
            f"{agent_index}\n\n"
            "Important AstrBot host rules:\n"
            "- Perform the full workflow directly in this agent session.\n"
            "- When the skill says to dispatch an agent, read the corresponding "
            "AstrBot agent prompt file and execute that role yourself.\n"
            "- Use absolute paths shown above. The plugin runtime root is "
            "`understand-anything/`, skills live in root `skills/`, and prompts "
            "live in `astrbot_adapter/prompts/agents/`.\n"
            "- Write output to the target project `.understand-anything/` exactly "
            "as Understand Anything expects.\n"
            "- Preserve Understand Anything JSON schema and Dashboard compatibility.\n"
        )

    def _project_root_from_args(self, raw_args: str) -> Path:
        token = self._first_path_token(raw_args)
        return self.security.resolve_project_path(token)

    def _resolve_job_project_root(
        self,
        *,
        raw_args: str,
        parsed_path: str | None,
        project_path: str | Path | None,
        project_id: str | None,
        project_name: str | None,
        project_ref: str | None,
    ) -> Path:
        if project_path:
            return self.security.resolve_project_path(project_path)
        if project_id or project_name or project_ref:
            return self.resolve_project_root(
                project_id=project_id,
                project_name=project_name,
                project_ref=project_ref,
            )
        if parsed_path:
            return self.security.resolve_project_path(parsed_path)
        return self.security.resolve_project_path(self._first_path_token(raw_args))

    @staticmethod
    def _first_path_token(raw_args: str) -> str | None:
        for token in UnderstandAnythingRunner._split_args(raw_args):
            if not token.startswith("--"):
                return token
        return None

    @staticmethod
    def _split_args(raw_args: str) -> list[str]:
        return split_args(raw_args)

    @staticmethod
    def _git_changed_files(project_root: Path) -> list[str]:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "diff", "--name-only"],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return []
        return [line.strip() for line in proc.stdout.splitlines() if line.strip()]

    def _track_project_from_flags(
        self,
        project_root: Path,
        flags: Sequence[str],
    ) -> bool | None:
        tokens = set(flags)
        if "--auto-update" in tokens:
            self._auto_update_projects.add(project_root)
            return True
        if "--no-auto-update" in tokens:
            self._auto_update_projects.discard(project_root)
            return False
        return None

    def _discover_auto_update_projects(self) -> None:
        candidates = set(self.security.allowed_roots)
        for root in list(candidates):
            if root.is_dir():
                candidates.update(
                    path.parent.parent
                    for path in root.glob("*/.understand-anything/config.json")
                )
        for project_root in candidates:
            if self._project_auto_update_enabled(project_root):
                self._auto_update_projects.add(project_root)

    async def _run_auto_update_pass(self) -> None:
        self._discover_auto_update_projects()
        for project_root in sorted(self._auto_update_projects):
            if not self._project_auto_update_enabled(project_root):
                self._auto_update_projects.discard(project_root)
                continue
            if self._has_running_project_job(project_root):
                continue
            if not self._project_is_stale(project_root):
                continue
            raw_args = format_job_args(project_root)
            job = self.jobs.create(
                "understand",
                project_root,
                {"raw_args": raw_args, "auto_update": True},
            )
            self.registry.register(
                project_root,
                job_id=job.job_id,
                auto_update=True,
            )
            self.jobs.append_log(job.job_id, "Auto-update detected a new git commit.")
            self._tasks[job.job_id] = asyncio.create_task(
                self._run_skill_job(job, None),
            )

    def _has_running_project_job(self, project_root: Path) -> bool:
        return any(
            job.project_root == project_root
            and job.status.value in {"queued", "running"}
            for job in self.jobs.list()
        )

    @staticmethod
    def _project_auto_update_enabled(project_root: Path) -> bool:
        config_path = project_root / ".understand-anything" / "config.json"
        if not config_path.is_file():
            return False
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return isinstance(config, dict) and config.get("autoUpdate") is True

    @staticmethod
    def _project_is_stale(project_root: Path) -> bool:
        meta_path = project_root / ".understand-anything" / "meta.json"
        if not meta_path.is_file():
            return False
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        previous_commit = meta.get("gitCommitHash") if isinstance(meta, dict) else None
        current_commit = UnderstandAnythingRunner._git_head(project_root)
        return bool(previous_commit and current_commit and previous_commit != current_commit)

    @staticmethod
    def _git_head(project_root: Path) -> str | None:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return None
        return proc.stdout.strip() or None

    @staticmethod
    def _synthetic_event(job: JobSnapshot) -> AstrMessageEvent:
        message = AstrBotMessage()
        text = f"/{SKILL_COMMANDS.get(job.kind, job.kind)} {job.args.get('raw_args', '')}"
        message.type = MessageType.FRIEND_MESSAGE
        message.self_id = PLUGIN_NAME
        message.session_id = f"dashboard:{job.job_id}"
        message.message_id = job.job_id
        message.sender = MessageMember(user_id="dashboard", nickname="AstrBot Dashboard")
        message.message = [Plain(text=text)]
        message.message_str = text
        message.raw_message = {"source": "plugin-page", "job_id": job.job_id}
        event = AstrMessageEvent(
            text,
            message,
            PlatformMetadata(
                name="plugin-page",
                description="AstrBot plugin page background job",
                id=PLUGIN_NAME,
            ),
            message.session_id,
        )
        event.role = "admin"
        event.is_wake = True
        event.is_at_or_wake_command = True
        return event

    async def _auto_update_loop(self, interval: int) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await self._run_auto_update_pass()
            except Exception as exc:
                logger.warning("Understand Anything auto-update poll failed: %s", exc)
