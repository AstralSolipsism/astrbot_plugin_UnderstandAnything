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

    @filter.command("understand")
    async def understand(self, event: AstrMessageEvent):
        """Analyze a project and generate an Understand Anything graph."""
        job = await self.runner.start_skill_job(
            skill_name="understand",
            raw_args=self._args(event, "understand"),
            event=event,
        )
        yield event.plain_result(
            f"Understand Anything analysis started. Job: {job.job_id}",
        )

    @filter.command("understand-dashboard", alias={"understand_dashboard"})
    async def understand_dashboard(self, event: AstrMessageEvent):
        """Open the bundled Understand Anything Dashboard page."""
        yield event.plain_result(
            "Open the AstrBot WebUI plugin detail page and launch the "
            "`dashboard` Page for this plugin.",
        )

    @filter.command("understand-chat", alias={"understand_chat"})
    async def understand_chat(self, event: AstrMessageEvent):
        """Ask a question using the current project's knowledge graph."""
        project_ref, query = self._parse_project_option(
            self._args(event, "understand-chat", "understand_chat"),
        )
        answer = await self.runner.chat(
            query=query,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @filter.command("understand-diff", alias={"understand_diff"})
    async def understand_diff(self, event: AstrMessageEvent):
        """Analyze current git changes against the knowledge graph."""
        project_ref, project_path = self._project_selector_from_args(
            self._args(event, "understand-diff", "understand_diff"),
        )
        answer = await self.runner.diff(
            project_path=project_path,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @filter.command("understand-domain", alias={"understand_domain"})
    async def understand_domain(self, event: AstrMessageEvent):
        """Extract business domain graph information."""
        job = await self.runner.start_skill_job(
            skill_name="understand-domain",
            raw_args=self._args(event, "understand-domain", "understand_domain"),
            event=event,
        )
        yield event.plain_result(
            f"Understand Anything domain analysis started. Job: {job.job_id}",
        )

    @filter.command("understand-explain", alias={"understand_explain"})
    async def understand_explain(self, event: AstrMessageEvent):
        """Explain a specific file, function, class, or module."""
        project_ref, target = self._parse_project_option(
            self._args(event, "understand-explain", "understand_explain"),
        )
        answer = await self.runner.explain(
            target=target,
            project_ref=project_ref,
            event=event,
        )
        yield event.plain_result(answer)

    @filter.command("understand-knowledge", alias={"understand_knowledge"})
    async def understand_knowledge(self, event: AstrMessageEvent):
        """Analyze a Karpathy-pattern wiki knowledge base."""
        job = await self.runner.start_skill_job(
            skill_name="understand-knowledge",
            raw_args=self._args(event, "understand-knowledge", "understand_knowledge"),
            event=event,
        )
        yield event.plain_result(
            f"Understand Anything knowledge analysis started. Job: {job.job_id}",
        )

    @filter.command("understand-onboard", alias={"understand_onboard"})
    async def understand_onboard(self, event: AstrMessageEvent):
        """Generate an onboarding guide from the knowledge graph."""
        project_ref, project_path = self._project_selector_from_args(
            self._args(event, "understand-onboard", "understand_onboard"),
        )
        markdown = await self.runner.onboard(
            project_path=project_path,
            project_ref=project_ref,
        )
        yield event.plain_result(markdown)

    @filter.llm_tool(name="ua_analyze_project")
    async def ua_analyze_project(self, event: AstrMessageEvent, project_path: str):
        """Analyze a project with Understand Anything.

        Args:
            project_path(string): Project directory to analyze.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            project_path=project_path,
            event=event,
        )
        return f"Started Understand Anything analysis job {job.job_id}."

    @filter.llm_tool(name="ua_analyze_github_repo")
    async def ua_analyze_github_repo(
        self,
        event: AstrMessageEvent,
        repo_url: str,
        ref: str = "",
    ):
        """Analyze a public GitHub repository with Understand Anything.

        Args:
            repo_url(string): Public https://github.com/owner/repo URL.
                May include /tree/<ref>/<path>.
            ref(string): Optional legacy branch, tag, or commit-ish ref override.
        """
        job = await self.runner.start_skill_job(
            skill_name="understand",
            repo_url=repo_url,
            ref=ref or None,
            event=event,
        )
        return f"Started Understand Anything GitHub analysis job {job.job_id}."

    @filter.llm_tool(name="ua_search_graph")
    async def ua_search_graph(
        self,
        event: AstrMessageEvent,
        query: str,
        project: str = "",
    ):
        """Search the current Understand Anything graph.

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
        """Explain a component from the current Understand Anything graph.

        Args:
            target(string): File path or file path plus symbol.
            project(string): Optional project name, id, alias, or path.
        """
        return await self.runner.explain(
            target=target,
            project_ref=project or None,
            event=event,
        )

    @filter.llm_tool(name="ua_chat_with_graph")
    async def ua_chat_with_graph(
        self,
        event: AstrMessageEvent,
        query: str,
        project: str = "",
    ):
        """Answer a question using the current Understand Anything graph.

        Args:
            query(string): User question about the project.
            project(string): Optional project name, id, alias, or path.
        """
        return await self.runner.chat(
            query=query,
            project_ref=project or None,
            event=event,
        )

    @filter.llm_tool(name="ua_analyze_diff")
    async def ua_analyze_diff(self, event: AstrMessageEvent, project_path: str):
        """Analyze git diff impact using the Understand Anything graph.

        Args:
            project_path(string): Project directory containing the graph.
        """
        return await self.runner.diff(project_path=project_path, event=event)

    @filter.llm_tool(name="ua_generate_onboarding")
    async def ua_generate_onboarding(self, event: AstrMessageEvent, project_path: str):
        """Generate onboarding markdown from the Understand Anything graph.

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
