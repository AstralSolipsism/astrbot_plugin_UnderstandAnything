from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

from .astrbot_adapter.constants import PLUGIN_NAME
from .astrbot_adapter.runner import UnderstandAnythingRunner
from .astrbot_adapter.web_api import UnderstandAnythingWebApi


class UnderstandAnythingPlugin(Star):
    def __init__(
        self,
        context: Context,
        config: AstrBotConfig | dict | None = None,
    ) -> None:
        super().__init__(context)
        self.config = dict(config or {})
        self.runner = UnderstandAnythingRunner(context, self.config)
        self.web_api = UnderstandAnythingWebApi(context, self.runner)
        self.webchat_context_store = self.web_api.webchat_proxy.context_store
        self.web_api.register()

    async def initialize(self) -> None:
        await self.runner.initialize()
        logger.info("Understand Anything plugin initialized.")

    async def terminate(self) -> None:
        await self.runner.terminate()
        logger.info("Understand Anything plugin terminated.")

    @filter.command_group("understand")
    def understand_commands(self):
        """Understand Anything command group."""
        pass

    @understand_commands.command("analyze")
    async def understand_analyze(self, event: AstrMessageEvent):
        """Analyze a project and generate an Understand Anything graph."""
        job = await self.runner.start_skill_job(
            skill_name="understand",
            raw_args=self._args(event, "understand analyze"),
            event=event,
        )
        if not job.args.get("started_notification_sent"):
            yield event.plain_result(self.runner.format_job_source_started_message(job))

    @understand_commands.command("status")
    async def understand_status(self, event: AstrMessageEvent):
        """Show compact progress for an Understand Anything job."""
        project_ref = self._args(event, "understand status").strip()
        yield event.plain_result(self.runner.format_job_status(project_ref or None))

    @understand_commands.command("dashboard")
    async def understand_dashboard_group(self, event: AstrMessageEvent):
        """Open the bundled Understand Anything Dashboard page."""
        yield event.plain_result(
            "Open the AstrBot WebUI plugin detail page and launch the "
            "`dashboard` Page for this plugin.",
        )

    @understand_commands.command("chat")
    async def understand_chat_group(self, event: AstrMessageEvent):
        """Ask a question using the current project's knowledge graph."""
        project_ref, query = self._parse_project_option(
            self._args(event, "understand chat"),
        )
        answer = await self.runner.chat(
            query=query,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @understand_commands.command("diff")
    async def understand_diff_group(self, event: AstrMessageEvent):
        """Analyze current git changes against the knowledge graph."""
        project_ref, project_path = self._project_selector_from_args(
            self._args(event, "understand diff"),
        )
        answer = await self.runner.diff(
            project_path=project_path,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @understand_commands.command("domain")
    async def understand_domain_group(self, event: AstrMessageEvent):
        """Extract business domain graph information."""
        job_label = "domain analysis"
        job = await self.runner.start_skill_job(
            skill_name="understand-domain",
            job_label=job_label,
            raw_args=self._args(event, "understand domain"),
            event=event,
        )
        if not job.args.get("started_notification_sent"):
            yield event.plain_result(
                self.runner.format_job_source_started_message(
                    job,
                    job_label=job_label,
                ),
            )

    @understand_commands.command("explain")
    async def understand_explain_group(self, event: AstrMessageEvent):
        """Explain a specific file, function, class, or module."""
        project_ref, target = self._parse_project_option(
            self._args(event, "understand explain"),
        )
        answer = await self.runner.explain(
            target=target,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @understand_commands.command("knowledge")
    async def understand_knowledge_group(self, event: AstrMessageEvent):
        """Analyze a Karpathy-pattern wiki knowledge base."""
        job_label = "knowledge analysis"
        job = await self.runner.start_skill_job(
            skill_name="understand-knowledge",
            job_label=job_label,
            raw_args=self._args(event, "understand knowledge"),
            event=event,
        )
        if not job.args.get("started_notification_sent"):
            yield event.plain_result(
                self.runner.format_job_source_started_message(
                    job,
                    job_label=job_label,
                ),
            )

    @understand_commands.command("onboard")
    async def understand_onboard_group(self, event: AstrMessageEvent):
        """Generate an onboarding guide from the knowledge graph."""
        project_ref, project_path = self._project_selector_from_args(
            self._args(event, "understand onboard"),
        )
        markdown = await self.runner.onboard(
            project_path=project_path,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(markdown)

    @filter.llm_tool(name="ua_start_project_analysis")
    async def ua_start_project_analysis(
        self,
        event: AstrMessageEvent,
        project_path: str,
    ):
        """Begin Understand Anything source preparation for a local project.

        Use this when the user asks to analyze a local repository or project.
        This tool creates the job and starts source preparation; the plugin will
        confirm scan scope before graph generation. Large repositories can take
        30 minutes or longer after confirmation. Do not assume the graph is
        ready until the job status is finished.
        User-facing lifecycle notifications are sent by the plugin.
        Do not say analysis has started until the plugin reports graph generation.

        Args:
            project_path(string): Project directory to analyze.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            project_path=project_path,
            event=event,
        )
        return self.runner.format_tool_job_submitted_message(job)

    @filter.llm_tool(name="ua_start_github_analysis")
    async def ua_start_github_analysis(
        self,
        event: AstrMessageEvent,
        repo_url: str,
        ref: str = "",
        github_proxy: str = "",
    ):
        """Begin Understand Anything source preparation for a GitHub repo.

        Use this when the user asks to analyze a public GitHub repository.
        This tool creates the job and starts GitHub source preparation; the
        plugin will confirm scan scope before graph generation. Large
        repositories can take 30 minutes or longer after confirmation. Do not
        assume the graph is ready until the job status is finished.
        User-facing lifecycle notifications are sent by the plugin.
        Do not say analysis has started until the plugin reports graph generation.

        Args:
            repo_url(string): Public https://github.com/owner/repo URL.
                May include /tree/<ref>/<path>.
            ref(string): Optional legacy branch, tag, or commit-ish ref override.
            github_proxy(string): Optional bundled proxy preset URL to try first.
                Leave empty for automatic direct GitHub, then proxy fallback.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            repo_url=repo_url,
            ref=ref or None,
            github_proxy=github_proxy or None,
            event=event,
        )
        return self.runner.format_tool_job_submitted_message(job)

    @filter.llm_tool(name="ua_get_analysis_status")
    async def ua_get_analysis_status(
        self,
        event: AstrMessageEvent,
        project: str = "",
    ):
        """Get compact progress for an Understand Anything job.

        Use this after starting an analysis job or when the user asks whether an
        analysis is still running. The response is a concise status summary and
        does not include raw job logs.
        After this tool returns, reply with exactly the returned message and do
        not add extra explanations, suggestions, or follow-up questions.

        Args:
            project(string): Optional project name, alias, or path. If empty,
                show the latest active job.
        """
        return self.runner.format_job_status(
            self._effective_status_project_ref(event, project),
        )

    @filter.llm_tool(name="ua_ask_graph")
    async def ua_ask_graph(
        self,
        event: AstrMessageEvent,
        query: str,
        project: str = "",
    ):
        """Answer a question using a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished. It is
        for questions about a project's generated knowledge graph, not for
        starting a new analysis.

        Args:
            query(string): Natural language query.
            project(string): Optional project name, id, alias, or path.
        """
        return await self.runner.chat(
            query=query,
            **self._effective_project_kwargs(event, project),
            event=event,
        )

    @filter.llm_tool(name="ua_explain_component")
    async def ua_explain_component(
        self,
        event: AstrMessageEvent,
        target: str,
        project: str = "",
    ):
        """Explain a component from a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished.

        Args:
            target(string): File path or file path plus symbol.
            project(string): Optional project name, id, alias, or path.
        """
        return await self.runner.explain(
            target=target,
            **self._effective_project_kwargs(event, project),
            event=event,
        )

    @filter.llm_tool(name="ua_analyze_diff")
    async def ua_analyze_diff(
        self,
        event: AstrMessageEvent,
        project_path: str = "",
    ):
        """Analyze git diff impact using a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished.

        Args:
            project_path(string): Project directory containing the graph.
        """
        project_kwargs = self._effective_project_kwargs(event, project_path)
        return await self.runner.diff(**project_kwargs, event=event)

    @filter.llm_tool(name="ua_generate_onboarding")
    async def ua_generate_onboarding(
        self,
        event: AstrMessageEvent,
        project_path: str = "",
    ):
        """Generate onboarding markdown from a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished.

        Args:
            project_path(string): Project directory containing the graph.
        """
        project_kwargs = self._effective_project_kwargs(event, project_path)
        return await self.runner.onboard(**project_kwargs, event=event)

    @filter.llm_tool(name="ua_open_dashboard")
    async def ua_open_dashboard(self, event: AstrMessageEvent):
        """Return instructions for opening the Understand Anything Dashboard."""
        return (
            f"Open AstrBot WebUI, go to plugin `{PLUGIN_NAME}`, then open "
            "the `dashboard` Page."
        )

    @staticmethod
    def _args(event: AstrMessageEvent, *command_names: str) -> str:
        message = event.get_message_str().strip()
        for command_name in command_names:
            for prefix in (command_name, f"/{command_name}"):
                if message == prefix:
                    return ""
                if message.startswith(f"{prefix} "):
                    return message[len(prefix) :].strip()
        return event.message_str.strip()

    def _first_path_arg(
        self, event: AstrMessageEvent, *command_names: str
    ) -> str | None:
        raw_args = self._args(event, *command_names)
        return self._first_path_token(raw_args)

    def _effective_project_kwargs(
        self,
        event: AstrMessageEvent,
        explicit_project: str = "",
    ) -> dict[str, Any]:
        webchat_context = self._webchat_context_for_event(event)
        context_items = webchat_context.get("context_items")
        explicit = str(explicit_project or "").strip()
        if explicit:
            kwargs: dict[str, Any] = {"project_ref": explicit}
            if isinstance(context_items, list) and context_items:
                kwargs["context_items"] = context_items
            return kwargs
        project_ref = webchat_context.get("project_ref")
        if not isinstance(project_ref, dict) or not project_ref:
            return {"project_ref": None}
        kwargs: dict[str, Any] = {}
        for key in ("project_id", "project_name", "project_path"):
            value = project_ref.get(key)
            if isinstance(value, str) and value.strip():
                kwargs[key] = value.strip()
        ref = project_ref.get("project_ref") or project_ref.get("project")
        if isinstance(ref, str) and ref.strip():
            kwargs["project_ref"] = ref.strip()
        if not kwargs:
            kwargs["project_ref"] = None
        if isinstance(context_items, list) and context_items:
            kwargs["context_items"] = context_items
        return kwargs

    def _effective_status_project_ref(
        self,
        event: AstrMessageEvent,
        explicit_project: str = "",
    ) -> str | None:
        explicit = str(explicit_project or "").strip()
        if explicit:
            return explicit
        project_kwargs = self._effective_project_kwargs(event)
        for key in ("project_ref", "project_id", "project_name", "project_path"):
            value = project_kwargs.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def _webchat_project_ref_for_event(
        self,
        event: AstrMessageEvent,
    ) -> dict[str, Any]:
        project_ref = self._webchat_context_for_event(event).get("project_ref")
        return project_ref if isinstance(project_ref, dict) else {}

    def _webchat_context_for_event(
        self,
        event: AstrMessageEvent,
    ) -> dict[str, Any]:
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        context_for_umo = getattr(self.webchat_context_store, "context_for_umo", None)
        if callable(context_for_umo):
            context = context_for_umo(umo)
            return context if isinstance(context, dict) else {}
        project_ref = self.webchat_context_store.project_ref_for_umo(umo)
        return {"project_ref": project_ref} if isinstance(project_ref, dict) else {}

    @staticmethod
    def _parse_project_option(raw_args: str) -> tuple[str | None, str]:
        tokens = UnderstandAnythingPlugin._split_args(raw_args)
        project_ref: str | None = None
        remaining: list[str] = []
        index = 0
        while index < len(tokens):
            token = tokens[index]
            if token == "--project":
                if index + 1 >= len(tokens):
                    raise ValueError("Missing value for --project.")
                project_ref = tokens[index + 1]
                index += 2
                continue
            if token.startswith("--project="):
                project_ref = token.split("=", 1)[1].strip()
                index += 1
                continue
            remaining.append(token)
            index += 1
        return project_ref, " ".join(remaining).strip()

    @staticmethod
    def _project_selector_from_args(raw_args: str) -> tuple[str | None, str | None]:
        project_ref, remaining = UnderstandAnythingPlugin._parse_project_option(
            raw_args
        )
        return project_ref, UnderstandAnythingPlugin._first_path_token(remaining)

    @staticmethod
    def _first_path_token(raw_args: str) -> str | None:
        for token in UnderstandAnythingPlugin._split_args(raw_args):
            if token and not token.startswith("--"):
                return str(Path(token))
        return None

    @staticmethod
    def _split_args(raw_args: str) -> list[str]:
        try:
            tokens = shlex.split(raw_args, posix=False)
        except ValueError:
            tokens = raw_args.split()
        return [token.strip("\"'") for token in tokens if token.strip("\"'")]
