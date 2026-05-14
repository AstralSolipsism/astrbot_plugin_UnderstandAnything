from __future__ import annotations

from typing import Any


class AstrBotHostAdapter:
    def __init__(self, context: Any | None) -> None:
        self.context = context

    async def send_message(self, event: Any | None, message_chain: Any) -> bool:
        if self.context is None or event is None:
            return False
        session = str(getattr(event, "unified_msg_origin", "") or "")
        if not session:
            return False
        send_message = getattr(self.context, "send_message", None)
        if not callable(send_message):
            return False
        return bool(await send_message(session, message_chain))

    def get_config(self, umo: str | None = None) -> Any:
        if self.context is None:
            return {}
        get_config = getattr(self.context, "get_config", None)
        if callable(get_config):
            return get_config(umo=umo) if umo else get_config()
        config = getattr(self.context, "config", None)
        if isinstance(config, dict):
            return config
        raise RuntimeError("AstrBot config is unavailable.")

    def default_config(self) -> Any:
        manager = self._config_manager()
        if manager is not None and hasattr(manager, "default_conf"):
            try:
                return manager.default_conf
            except Exception:
                pass
        return self.get_config()

    def config_infos(self) -> list[dict[str, Any]]:
        manager = self._config_manager()
        get_conf_list = getattr(manager, "get_conf_list", None)
        if not callable(get_conf_list):
            return []
        try:
            infos = get_conf_list()
        except Exception:
            return []
        return [info for info in infos or [] if isinstance(info, dict)]

    def config_info_for_umo(self, umo: str | None) -> dict[str, Any]:
        if not umo:
            return {}
        manager = self._config_manager()
        get_conf_info = getattr(manager, "get_conf_info", None)
        if not callable(get_conf_info):
            return {}
        try:
            info = get_conf_info(umo)
        except Exception:
            return {}
        return info if isinstance(info, dict) else {}

    def config_by_id(self, config_id: str) -> Any:
        if config_id == "default":
            return self.default_config()
        manager = self._config_manager()
        confs = getattr(manager, "confs", {})
        if isinstance(confs, dict) and config_id in confs:
            return confs[config_id]
        return {}

    def get_all_chat_providers(self) -> list[Any]:
        if self.context is None:
            return []
        get_all_providers = getattr(self.context, "get_all_providers", None)
        if not callable(get_all_providers):
            return []
        return list(get_all_providers() or [])

    def get_using_provider(self, umo: str | None = None) -> Any | None:
        if self.context is None:
            return None
        get_using_provider = getattr(self.context, "get_using_provider", None)
        if not callable(get_using_provider):
            return None
        return get_using_provider(umo)

    def get_provider_by_id(self, provider_id: str) -> Any | None:
        if self.context is None or not provider_id:
            return None
        get_provider_by_id = getattr(self.context, "get_provider_by_id", None)
        if callable(get_provider_by_id):
            provider = get_provider_by_id(provider_id)
            if provider is not None:
                return provider
        manager = self._provider_manager()
        inst_map = getattr(manager, "inst_map", None)
        if isinstance(inst_map, dict):
            return inst_map.get(provider_id)
        return None

    def chat_provider_config_records(self) -> list[dict[str, Any]]:
        manager = self._provider_manager()
        if manager is None:
            return []
        sources = {
            str(item.get("id", "")): str(
                item.get("provider_type") or "chat_completion",
            )
            for item in getattr(manager, "provider_sources_config", []) or []
            if isinstance(item, dict)
        }
        records: list[dict[str, Any]] = []
        for provider_config in getattr(manager, "providers_config", []) or []:
            if not isinstance(provider_config, dict):
                continue
            source_id = provider_config.get("provider_source_id")
            source_type = sources.get(str(source_id or "")) if source_id else None
            provider_type = source_type or str(
                provider_config.get("provider_type") or ""
            )
            if provider_type != "chat_completion":
                continue
            get_merged = getattr(manager, "get_merged_provider_config", None)
            records.append(
                get_merged(provider_config)
                if callable(get_merged)
                else dict(provider_config)
            )
        return records

    def persona_manager(self, *, required: bool) -> Any | None:
        persona_mgr = getattr(self.context, "persona_manager", None)
        if persona_mgr is None:
            orchestrator = getattr(self.context, "subagent_orchestrator", None)
            persona_mgr = getattr(orchestrator, "_persona_mgr", None)
        if persona_mgr is None and required:
            raise RuntimeError("AstrBot persona manager is unavailable.")
        return persona_mgr

    def persona_data(self, persona_mgr: Any | None, persona_id: str) -> Any:
        if persona_mgr is None:
            return None
        record = self.persona_record(persona_mgr, persona_id)
        if record is not None:
            return record
        get_persona_v3_by_id = getattr(persona_mgr, "get_persona_v3_by_id", None)
        if callable(get_persona_v3_by_id):
            return get_persona_v3_by_id(persona_id)
        return None

    def persona_record(self, persona_mgr: Any | None, persona_id: str) -> Any:
        if persona_mgr is None:
            return None
        records = getattr(persona_mgr, "personas", None)
        if isinstance(records, dict):
            return records.get(persona_id)
        if isinstance(records, list):
            for record in records:
                if (
                    getattr(record, "persona_id", None) == persona_id
                    or getattr(record, "name", None) == persona_id
                ):
                    return record
                if isinstance(record, dict) and (
                    record.get("persona_id") == persona_id
                    or record.get("name") == persona_id
                ):
                    return record
        return None

    async def find_or_create_persona_folder(
        self,
        persona_mgr: Any,
        *,
        name: str,
        description: str,
    ) -> str | None:
        get_folders = getattr(persona_mgr, "get_folders", None)
        create_folder = getattr(persona_mgr, "create_folder", None)
        if not callable(get_folders) or not callable(create_folder):
            raise RuntimeError("AstrBot persona folder APIs are unavailable.")

        folders = await get_folders(None)
        if isinstance(folders, list):
            for folder in folders:
                folder_name = self.value(folder, "name")
                parent_id = self.value(folder, "parent_id")
                if folder_name == name and parent_id is None:
                    folder_id = self.value(folder, "folder_id")
                    return str(folder_id) if folder_id else None

        folder = await create_folder(
            name=name,
            parent_id=None,
            description=description,
            sort_order=0,
        )
        folder_id = self.value(folder, "folder_id")
        return str(folder_id) if folder_id else None

    async def move_persona_to_folder(
        self,
        persona_mgr: Any,
        persona_id: str,
        folder_id: str | None,
    ) -> None:
        if folder_id is None:
            return
        record = self.persona_record(persona_mgr, persona_id)
        if self.value(record, "folder_id") == folder_id:
            return
        move_persona_to_folder = getattr(persona_mgr, "move_persona_to_folder", None)
        if callable(move_persona_to_folder):
            await move_persona_to_folder(persona_id, folder_id)

    @staticmethod
    def value(record: Any, *keys: str) -> Any:
        for key in keys:
            if isinstance(record, dict) and key in record:
                return record.get(key)
            if hasattr(record, key):
                return getattr(record, key)
        return None

    def _config_manager(self) -> Any | None:
        return getattr(self.context, "astrbot_config_mgr", None)

    def _provider_manager(self) -> Any | None:
        return getattr(self.context, "provider_manager", None)
