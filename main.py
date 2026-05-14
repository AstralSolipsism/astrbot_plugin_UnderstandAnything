from __future__ import annotations

import shlex
from pathlib import Path

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
        yield event.plain_result(self._format_job_started_message(job.job_id))

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
        job = await self.runner.start_skill_job(
            skill_name="understand-domain",
            raw_args=self._args(event, "understand domain"),
            event=event,
        )
        yield event.plain_result(
            self._format_job_started_message(job.job_id, job_label="domain analysis"),
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
        job = await self.runner.start_skill_job(
            skill_name="understand-knowledge",
            raw_args=self._args(event, "understand knowledge"),
            event=event,
        )
        yield event.plain_result(
            self._format_job_started_message(
                job.job_id,
                job_label="knowledge analysis",
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
        """Start a background Understand Anything analysis job for a local project.

        Use this when the user asks to analyze a local repository or project.
        This tool returns after scheduling the job; the analysis keeps running in
        the background and can take 30 minutes or longer for large repositories.
        Do not assume the graph is ready until the job status is finished.
        Tell the user the returned job id and how to check progress.

        Args:
            project_path(string): Project directory to analyze.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            project_path=project_path,
            event=event,
        )
        return self._format_job_started_message(job.job_id)

    @filter.llm_tool(name="ua_start_github_analysis")
    async def ua_start_github_analysis(
        self,
        event: AstrMessageEvent,
        repo_url: str,
        ref: str = "",
        github_proxy: str = "",
    ):
        """Start a background Understand Anything analysis job for a GitHub repo.

        Use this when the user asks to analyze a public GitHub repository.
        This tool returns after scheduling the job; source preparation and graph
        analysis keep running in the background and can take 30 minutes or longer
        for large repositories. Do not assume the graph is ready until the job
        status is finished. Tell the user the returned job id and how to check
        progress.

        Args:
            repo_url(string): Public https://github.com/owner/repo URL.
                May include /tree/<ref>/<path>.
            ref(string): Optional legacy branch, tag, or commit-ish ref override.
            github_proxy(string): Optional bundled proxy preset URL for GitHub
                network failures. Leave empty for direct GitHub access.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            repo_url=repo_url,
            ref=ref or None,
            github_proxy=github_proxy or None,
            event=event,
        )
        return self._format_job_started_message(job.job_id)

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
        return self.runner.format_job_status(project or None)

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
            project_ref=project or None,
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
            project_ref=project or None,
            event=event,
        )

    @filter.llm_tool(name="ua_analyze_diff")
    async def ua_analyze_diff(self, event: AstrMessageEvent, project_path: str):
        """Analyze git diff impact using a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished.

        Args:
            project_path(string): Project directory containing the graph.
        """
        return await self.runner.diff(project_path=project_path, event=event)

    @filter.llm_tool(name="ua_generate_onboarding")
    async def ua_generate_onboarding(self, event: AstrMessageEvent, project_path: str):
        """Generate onboarding markdown from a finished Understand Anything graph.

        Use this only after the relevant analysis job status is finished.

        Args:
            project_path(string): Project directory containing the graph.
        """
        return await self.runner.onboard(project_path=project_path)

    @filter.llm_tool(name="ua_open_dashboard")
    async def ua_open_dashboard(self, event: AstrMessageEvent):
        """Return instructions for opening the Understand Anything Dashboard."""
        return (
            f"Open AstrBot WebUI, go to plugin `{PLUGIN_NAME}`, then open "
            "the `dashboard` Page."
        )

    @staticmethod
    def _format_job_started_message(
        job_id: str,
        *,
        job_label: str = "analysis",
    ) -> str:
        return (
            f"Started background Understand Anything {job_label} job {job_id}. "
            "Large repositories can take 30 minutes or longer. "
            f"Check progress with `/understand status {job_id}`. "
            "The graph is not ready until the job status is finished; this chat "
            "will be notified when the job finishes or fails."
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
