from __future__ import annotations

from typing import Any

from .astrbot_host import AstrBotHostAdapter

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
    host = AstrBotHostAdapter(context)
    configs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for info in host.config_infos():
        config_id = str(info.get("id") or "default")
        if config_id in seen:
            continue
        seen.add(config_id)
        configs.append(
            _config_status(
                config_id=config_id,
                name=str(info.get("name") or config_id),
                config=host.config_by_id(config_id),
                is_default=config_id == "default",
            ),
        )
    if "default" not in seen:
        configs.append(
            _config_status(
                config_id="default",
                name="default",
                config=host.default_config(),
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
    host = AstrBotHostAdapter(context)
    config_info = host.config_info_for_umo(umo)
    config_id = str(config_info.get("id") or "")
    if config_id:
        for config in configs:
            if config["id"] == config_id:
                return config
    return _config_status(
        config_id=config_id or default_config["id"],
        name=str(config_info.get("name") or default_config["name"]),
        config=host.get_config(umo=umo),
        is_default=(config_id or default_config["id"]) == "default",
    )


def _provider_settings_from_config(config: Any) -> dict[str, Any]:
    if not hasattr(config, "get"):
        return {}
    provider_settings = config.get("provider_settings", {})
    return provider_settings if isinstance(provider_settings, dict) else {}
