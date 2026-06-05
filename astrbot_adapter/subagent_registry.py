from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from astrbot.core.star import Context

from .astrbot_host import AstrBotHostAdapter
from .constants import AGENT_PROMPTS_ROOT, PLUGIN_NAME

ROLE_NAMES = (
    "project-scanner",
    "file-analyzer",
    "assemble-reviewer",
    "architecture-analyzer",
    "tour-builder",
    "graph-reviewer",
    "domain-analyzer",
    "article-analyzer",
)

UA_AGENT_TOOLS = (
    "astrbot_execute_shell",
    "astrbot_execute_python",
    "astrbot_file_read_tool",
    "astrbot_file_write_tool",
    "astrbot_file_edit_tool",
    "astrbot_grep_tool",
)

UA_SANDBOX_AGENT_TOOLS = (
    "astrbot_execute_shell",
    "astrbot_execute_ipython",
    "astrbot_upload_file",
    "astrbot_download_file",
    "astrbot_file_read_tool",
    "astrbot_file_write_tool",
    "astrbot_file_edit_tool",
    "astrbot_grep_tool",
)

UA_ROLE_SKILLS: dict[str, tuple[str, ...]] = {
    "project-scanner": ("understand",),
    "file-analyzer": ("understand",),
    "assemble-reviewer": ("understand",),
    "architecture-analyzer": ("understand",),
    "tour-builder": ("understand",),
    "graph-reviewer": ("understand",),
    "domain-analyzer": ("understand-domain",),
    "article-analyzer": ("understand-knowledge",),
}

UA_PERSONA_FOLDER_NAME = "Understand Anything"
UA_PERSONA_FOLDER_DESCRIPTION = (
    "Personas managed by the Understand Anything plugin for UA SubAgents."
)


@dataclass(frozen=True)
class UASubAgentSpec:
    role: str
    agent_name: str
    persona_id: str
    handoff_name: str
    prompt: str
    prompt_sha256: str
    skills: tuple[str, ...]


class UnderstandAnythingSubAgentRegistry:
    def __init__(
        self,
        context: Context | None,
        plugin_config: dict[str, Any] | None = None,
    ) -> None:
        self.context = context
        self.host = AstrBotHostAdapter(context)
        self.plugin_config = plugin_config or {}

    def status_payload(self) -> dict[str, Any]:
        if self.context is None:
            return self.unavailable_status("AstrBot context is unavailable.")

        cfg = self._core_config()
        data = self._orchestrator_config(cfg)
        agents = data.get("agents", [])
        if not isinstance(agents, list):
            agents = []
        metadata = data.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        persona_folder_id = metadata.get("ua_persona_folder_id")
        persona_folder_id = (
            str(persona_folder_id).strip() if persona_folder_id else None
        )

        by_name = {
            str(item.get("name", "")).strip(): item
            for item in agents
            if isinstance(item, dict)
        }
        loaded_handoffs = self._loaded_handoff_names()

        roles: list[dict[str, Any]] = []
        missing: list[str] = []
        stale: list[str] = []
        unloaded: list[str] = []
        provider_id = self._desired_provider_id(data)
        persona_mgr = self._persona_manager(required=False)
        for spec in self.specs():
            existing = by_name.get(spec.agent_name)
            if existing is None:
                role_status = "missing"
                reasons = ["missing"]
                missing.append(spec.role)
            else:
                reasons = self._stale_reasons(
                    existing,
                    spec,
                    provider_id,
                    persona_mgr,
                    persona_folder_id,
                )
                role_status = "stale" if reasons else "registered"
                if reasons:
                    stale.append(spec.role)

            loaded = spec.handoff_name in loaded_handoffs
            if role_status == "registered" and not loaded:
                unloaded.append(spec.role)

            roles.append(
                {
                    "role": spec.role,
                    "agent_name": spec.agent_name,
                    "persona_id": spec.persona_id,
                    "handoff_name": spec.handoff_name,
                    "status": role_status,
                    "registered": existing is not None,
                    "persona_registered": self._persona_exists(persona_mgr, spec),
                    "persona_stale_reasons": self._persona_stale_reasons(
                        persona_mgr,
                        spec,
                        persona_folder_id,
                    ),
                    "loaded": loaded,
                    "stale_reasons": reasons,
                }
            )

        ready = not missing and not stale and not unloaded
        return {
            "ready": ready,
            "roles": roles,
            "missing_roles": missing,
            "stale_roles": stale,
            "unloaded_roles": unloaded,
            "registered_count": len(ROLE_NAMES) - len(missing),
            "required_count": len(ROLE_NAMES),
            "provider_override_configured": provider_id is not None,
            "persona_folder_name": UA_PERSONA_FOLDER_NAME,
            "persona_folder_id": persona_folder_id,
            "main_enable": bool(data.get("main_enable", False)),
            "remove_main_duplicate_tools": bool(
                data.get("remove_main_duplicate_tools", False)
            ),
        }

    async def register_required_subagents(
        self,
        *,
        provider_id: str | None = None,
        provider_id_provided: bool = False,
    ) -> dict[str, Any]:
        if self.context is None:
            raise RuntimeError("AstrBot context is unavailable.")

        cfg = self._core_config()
        data = dict(self._orchestrator_config(cfg))
        agents_raw = data.get("agents", [])
        agents = list(agents_raw) if isinstance(agents_raw, list) else []

        ua_names = {spec.agent_name for spec in self.specs()}
        preserved = [
            item
            for item in agents
            if not (
                isinstance(item, dict) and str(item.get("name", "")).strip() in ua_names
            )
        ]
        data.setdefault("main_enable", False)
        data.setdefault("remove_main_duplicate_tools", False)
        metadata = data.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        if provider_id_provided:
            selected_provider_id = str(provider_id or "").strip() or None
            if selected_provider_id:
                self._validate_provider_id(selected_provider_id)
                metadata["ua_provider_id"] = selected_provider_id
            else:
                metadata.pop("ua_provider_id", None)
            metadata["ua_provider_selected"] = True

        specs = self.specs()
        persona_folder_id = await self._ensure_persona_folder()
        persona_upserted = await self._upsert_personas(specs, persona_folder_id)

        metadata["ua_persona_folder_name"] = UA_PERSONA_FOLDER_NAME
        metadata["ua_persona_folder_id"] = persona_folder_id
        data["metadata"] = metadata
        desired_provider_id = self._desired_provider_id(data)
        desired = [self._agent_config(spec, desired_provider_id) for spec in specs]
        data["agents"] = preserved + desired
        cfg["subagent_orchestrator"] = data

        save_config = getattr(cfg, "save_config", None)
        if callable(save_config):
            save_config()

        orchestrator = getattr(self.context, "subagent_orchestrator", None)
        reload_from_config = getattr(orchestrator, "reload_from_config", None)
        if callable(reload_from_config):
            await reload_from_config(data)

        payload = self.status_payload()
        payload["upserted_count"] = len(desired)
        payload["persona_upserted_count"] = persona_upserted
        payload["persona_folder_id"] = persona_folder_id
        payload["preserved_count"] = len(preserved)
        return payload

    def desired_provider_id(self) -> str | None:
        if self.context is None:
            return self._desired_provider_id(None)
        try:
            cfg = self._core_config()
            data = self._orchestrator_config(cfg)
        except Exception:
            data = None
        return self._desired_provider_id(data)

    @classmethod
    def specs(cls) -> tuple[UASubAgentSpec, ...]:
        specs: list[UASubAgentSpec] = []
        for role in ROLE_NAMES:
            agent_name = cls.agent_name_for_role(role)
            prompt = cls.prompt_for_role(role)
            specs.append(
                UASubAgentSpec(
                    role=role,
                    agent_name=agent_name,
                    persona_id=agent_name,
                    handoff_name=f"transfer_to_{agent_name}",
                    prompt=prompt,
                    prompt_sha256=hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                    skills=cls.skills_for_role(role),
                )
            )
        return tuple(specs)

    @staticmethod
    def agent_name_for_role(role: str) -> str:
        return f"ua_{role.replace('-', '_')}"

    @staticmethod
    def skills_for_role(role: str) -> tuple[str, ...]:
        return UA_ROLE_SKILLS.get(role, ())

    @staticmethod
    def prompt_for_role(role: str) -> str:
        prompt_path = AGENT_PROMPTS_ROOT / f"{role}.md"
        if not prompt_path.is_file():
            raise FileNotFoundError(f"UA SubAgent prompt not found: {prompt_path}")
        return prompt_path.read_text(encoding="utf-8")

    @staticmethod
    def unavailable_status(message: str) -> dict[str, Any]:
        return {
            "ready": False,
            "roles": [],
            "missing_roles": list(ROLE_NAMES),
            "stale_roles": [],
            "unloaded_roles": [],
            "registered_count": 0,
            "required_count": len(ROLE_NAMES),
            "provider_override_configured": False,
            "main_enable": False,
            "remove_main_duplicate_tools": False,
            "error": message,
        }

    def _agent_config(
        self,
        spec: UASubAgentSpec,
        provider_id: str | None,
    ) -> dict[str, Any]:
        tools = self._agent_tools()
        return {
            "name": spec.agent_name,
            "enabled": True,
            "persona_id": spec.persona_id,
            "provider_id": provider_id,
            "public_description": (f"Understand Anything worker role: {spec.role}."),
            "system_prompt": spec.prompt,
            "tools": list(tools),
            "metadata": {
                "owner": PLUGIN_NAME,
                "ua_role": spec.role,
                "persona_id": spec.persona_id,
                "prompt_sha256": spec.prompt_sha256,
                "computer_use_runtime": self._computer_use_runtime(),
            },
        }

    def _stale_reasons(
        self,
        existing: dict[str, Any],
        spec: UASubAgentSpec,
        provider_id: str | None,
        persona_mgr: Any,
        persona_folder_id: str | None,
    ) -> list[str]:
        reasons: list[str] = []
        if existing.get("enabled", True) is not True:
            reasons.append("disabled")
        if str(existing.get("persona_id", "")).strip() != spec.persona_id:
            reasons.append("persona_id")
        if str(existing.get("system_prompt", "")) != spec.prompt:
            reasons.append("prompt")
        if str(existing.get("public_description", "")) != (
            f"Understand Anything worker role: {spec.role}."
        ):
            reasons.append("description")
        if existing.get("tools") != list(self._agent_tools()):
            reasons.append("tools")
        existing_provider = existing.get("provider_id")
        existing_provider = (
            str(existing_provider).strip() if existing_provider else None
        )
        if existing_provider != provider_id:
            reasons.append("provider")
        reasons.extend(
            self._persona_stale_reasons(persona_mgr, spec, persona_folder_id)
        )
        return reasons

    def _agent_tools(self) -> tuple[str, ...]:
        if self._computer_use_runtime() == "sandbox":
            return UA_SANDBOX_AGENT_TOOLS
        return UA_AGENT_TOOLS

    def _computer_use_runtime(self) -> str:
        if self.context is None:
            return "local"
        try:
            config = self.context.get_config()
        except Exception:
            config = {}
        provider_settings = (
            config.get("provider_settings", {})
            if hasattr(config, "get")
            else {}
        )
        return str(provider_settings.get("computer_use_runtime") or "none")

    async def _upsert_personas(
        self,
        specs: tuple[UASubAgentSpec, ...],
        folder_id: str | None,
    ) -> int:
        persona_mgr = self._persona_manager(required=True)
        upserted = 0
        for spec in specs:
            reasons = self._persona_stale_reasons(persona_mgr, spec, folder_id)
            if not reasons:
                continue
            existing = self._persona_exists(persona_mgr, spec)
            if existing:
                update_persona = getattr(persona_mgr, "update_persona", None)
                if not callable(update_persona):
                    raise RuntimeError(
                        "AstrBot persona manager cannot update personas."
                    )
                await update_persona(
                    persona_id=spec.persona_id,
                    system_prompt=spec.prompt,
                    begin_dialogs=[],
                    tools=list(self._agent_tools()),
                    skills=list(spec.skills),
                    custom_error_message=None,
                )
                await self._move_persona_to_folder(
                    persona_mgr,
                    spec.persona_id,
                    folder_id,
                )
            else:
                create_persona = getattr(persona_mgr, "create_persona", None)
                if not callable(create_persona):
                    raise RuntimeError(
                        "AstrBot persona manager cannot create personas."
                    )
                await create_persona(
                    persona_id=spec.persona_id,
                    system_prompt=spec.prompt,
                    begin_dialogs=[],
                    tools=list(self._agent_tools()),
                    skills=list(spec.skills),
                    custom_error_message=None,
                    folder_id=folder_id,
                )
            upserted += 1
        return upserted

    async def _ensure_persona_folder(self) -> str | None:
        persona_mgr = self._persona_manager(required=True)
        return await self.host.find_or_create_persona_folder(
            persona_mgr,
            name=UA_PERSONA_FOLDER_NAME,
            description=UA_PERSONA_FOLDER_DESCRIPTION,
        )

    async def _move_persona_to_folder(
        self,
        persona_mgr: Any,
        persona_id: str,
        folder_id: str | None,
    ) -> None:
        await self.host.move_persona_to_folder(persona_mgr, persona_id, folder_id)

    def _persona_manager(self, *, required: bool) -> Any:
        return self.host.persona_manager(required=required)

    def _persona_exists(self, persona_mgr: Any, spec: UASubAgentSpec) -> bool:
        return self._persona_data(persona_mgr, spec) is not None

    def _persona_stale_reasons(
        self,
        persona_mgr: Any,
        spec: UASubAgentSpec,
        folder_id: str | None = None,
    ) -> list[str]:
        persona = self._persona_data(persona_mgr, spec)
        if persona is None:
            return ["persona_missing"]
        reasons: list[str] = []
        prompt = self._persona_get(persona, "prompt", "system_prompt")
        if str(prompt or "") != spec.prompt:
            reasons.append("persona_prompt")
        tools = self._persona_get(persona, "tools")
        if tools != list(self._agent_tools()):
            reasons.append("persona_tools")
        skills = self._persona_get(persona, "skills")
        if skills != list(spec.skills):
            reasons.append("persona_skills")
        if folder_id is not None:
            record = self.host.persona_record(persona_mgr, spec.persona_id)
            if self._persona_get(record, "folder_id") != folder_id:
                reasons.append("persona_folder")
        return reasons

    def _persona_data(self, persona_mgr: Any, spec: UASubAgentSpec) -> Any:
        return self.host.persona_data(persona_mgr, spec.persona_id)

    @staticmethod
    def _persona_get(persona: Any, *keys: str) -> Any:
        for key in keys:
            if isinstance(persona, dict) and key in persona:
                return persona.get(key)
            if hasattr(persona, key):
                return getattr(persona, key)
        return None

    def _desired_provider_id(self, data: dict[str, Any] | None = None) -> str | None:
        metadata = data.get("metadata") if isinstance(data, dict) else None
        if isinstance(metadata, dict) and metadata.get("ua_provider_selected") is True:
            provider_id = str(metadata.get("ua_provider_id") or "").strip()
            return provider_id or None
        provider_id = str(
            self.plugin_config.get("subagent_provider_id")
            or self.plugin_config.get("provider_id")
            or ""
        ).strip()
        if provider_id:
            return provider_id
        return self._inferred_registered_provider_id(data)

    def _inferred_registered_provider_id(
        self,
        data: dict[str, Any] | None,
    ) -> str | None:
        if not isinstance(data, dict):
            return None
        agents = data.get("agents")
        if not isinstance(agents, list):
            return None

        ua_names = {spec.agent_name for spec in self.specs()}
        providers: list[str | None] = []
        for item in agents:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if name not in ua_names:
                continue
            provider_id = item.get("provider_id")
            providers.append(str(provider_id).strip() if provider_id else None)

        if len(providers) != len(ua_names):
            return None
        unique_providers = set(providers)
        if len(unique_providers) != 1:
            return None
        return next(iter(unique_providers))

    def _validate_provider_id(self, provider_id: str) -> None:
        if not provider_id:
            return
        if self.host.get_provider_by_id(provider_id) is not None:
            return
        raise ValueError(f"Provider {provider_id} is not available.")

    def _core_config(self) -> dict[str, Any]:
        return self.host.get_config()

    @staticmethod
    def _orchestrator_config(cfg: dict[str, Any]) -> dict[str, Any]:
        data = cfg.get("subagent_orchestrator")
        if not isinstance(data, dict):
            data = {}
        data.setdefault("main_enable", False)
        data.setdefault("remove_main_duplicate_tools", False)
        data.setdefault("agents", [])
        return data

    def _loaded_handoff_names(self) -> set[str]:
        orchestrator = getattr(self.context, "subagent_orchestrator", None)
        handoffs = getattr(orchestrator, "handoffs", [])
        if not isinstance(handoffs, list):
            return set()
        return {
            str(getattr(handoff, "name", "")).strip()
            for handoff in handoffs
            if str(getattr(handoff, "name", "")).strip()
        }
