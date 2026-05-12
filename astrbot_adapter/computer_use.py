from __future__ import annotations

from typing import Any

ENABLED_COMPUTER_USE_RUNTIMES = {"local", "sandbox"}
COMPUTER_USE_DISABLED_MESSAGE = (
    "AstrBot Computer Use runtime is disabled. In AstrBot settings, set "
    "使用电脑能力 -> 运行环境 to local or sandbox before starting "
    "Understand Anything analysis."
)


def computer_use_status(context: Any, umo: str | None = None) -> dict[str, Any]:
    configs = _all_config_statuses(context)
    default_config = next(
        (config for config in configs if config["is_default"]),
        configs[0],
    )
    effective_config = _effective_config_status(context, umo, configs, default_config)
    enabled_count = sum(1 for config in configs if config["enabled"])
    disabled_count = len(configs) - enabled_count
    return {
        "runtime": effective_config["runtime"],
        "enabled": effective_config["enabled"],
        "require_admin": effective_config["require_admin"],
        "sandbox_booter": effective_config["sandbox_booter"],
        "blocking_reason": effective_config["blocking_reason"],
        "configs": configs,
        "default_config": default_config,
        "enabled_count": enabled_count,
        "disabled_count": disabled_count,
        "all_enabled": disabled_count == 0,
        "effective_config_id": effective_config["id"],
        "dashboard_effective_config_id": default_config["id"],
    }


def ensure_computer_use_enabled(context: Any, umo: str | None = None) -> None:
    status = computer_use_status(context, umo=umo)
    if not status["enabled"]:
        raise RuntimeError(str(status["blocking_reason"]))


def _config_status(
    *,
    config_id: str,
    name: str,
    config: Any,
    is_default: bool,
) -> dict[str, Any]:
    provider_settings = _provider_settings_from_config(config)
    runtime = str(provider_settings.get("computer_use_runtime") or "none")
    sandbox = provider_settings.get("sandbox")
    if not isinstance(sandbox, dict):
        sandbox = {}
    enabled = runtime in ENABLED_COMPUTER_USE_RUNTIMES
    return {
        "id": config_id,
        "name": name,
        "is_default": is_default,
        "runtime": runtime,
        "enabled": enabled,
        "require_admin": bool(
            provider_settings.get("computer_use_require_admin", True),
        ),
        "sandbox_booter": str(sandbox.get("booter") or ""),
        "blocking_reason": "" if enabled else _blocking_reason(runtime),
    }


def _all_config_statuses(context: Any) -> list[dict[str, Any]]:
    config_manager = getattr(context, "astrbot_config_mgr", None)
    confs = getattr(config_manager, "confs", {})
    if not isinstance(confs, dict):
        confs = {}
    configs: list[dict[str, Any]] = []
    seen: set[str] = set()
    if config_manager is not None and hasattr(config_manager, "get_conf_list"):
        try:
            config_infos = config_manager.get_conf_list()
        except Exception:
            config_infos = []
        for info in config_infos:
            if not isinstance(info, dict):
                continue
            config_id = str(info.get("id") or "default")
            if config_id in seen:
                continue
            seen.add(config_id)
            config = _config_by_id(context, config_manager, confs, config_id)
            configs.append(
                _config_status(
                    config_id=config_id,
                    name=str(info.get("name") or config_id),
                    config=config,
                    is_default=config_id == "default",
                ),
            )
    if "default" not in seen:
        configs.append(
            _config_status(
                config_id="default",
                name="default",
                config=_default_config(context, config_manager),
                is_default=True,
            ),
        )
    return configs


def _blocking_reason(runtime: str) -> str:
    if runtime == "none":
        return COMPUTER_USE_DISABLED_MESSAGE
    return (
        f"Unsupported AstrBot Computer Use runtime: {runtime}. Set "
        "使用电脑能力 -> 运行环境 to local or sandbox."
    )


def _effective_config_status(
    context: Any,
    umo: str | None,
    configs: list[dict[str, Any]],
    default_config: dict[str, Any],
) -> dict[str, Any]:
    if not umo:
        return default_config
    config_manager = getattr(context, "astrbot_config_mgr", None)
    config_info: dict[str, Any] = {}
    if config_manager is not None and hasattr(config_manager, "get_conf_info"):
        try:
            raw_info = config_manager.get_conf_info(umo)
            if isinstance(raw_info, dict):
                config_info = raw_info
        except Exception:
            config_info = {}
    config_id = str(config_info.get("id") or "")
    if config_id:
        for config in configs:
            if config["id"] == config_id:
                return config
    return _config_status(
        config_id=config_id or default_config["id"],
        name=str(config_info.get("name") or default_config["name"]),
        config=_context_config(context, umo=umo),
        is_default=(config_id or default_config["id"]) == "default",
    )


def _config_by_id(
    context: Any,
    config_manager: Any,
    confs: dict[str, Any],
    config_id: str,
) -> Any:
    if config_id == "default":
        return _default_config(context, config_manager)
    return confs.get(config_id, {})


def _default_config(context: Any, config_manager: Any) -> Any:
    if config_manager is not None and hasattr(config_manager, "default_conf"):
        try:
            return config_manager.default_conf
        except Exception:
            pass
    return _context_config(context)


def _context_config(context: Any, umo: str | None = None) -> Any:
    config: Any = {}
    if context is not None and hasattr(context, "get_config"):
        try:
            config = context.get_config(umo=umo) if umo else context.get_config()
        except Exception:
            config = {}
    return config


def _provider_settings_from_config(config: Any) -> dict[str, Any]:
    if not hasattr(config, "get"):
        return {}
    provider_settings = config.get("provider_settings", {})
    return provider_settings if isinstance(provider_settings, dict) else {}
