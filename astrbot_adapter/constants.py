from __future__ import annotations

from pathlib import Path

PLUGIN_NAME = "astrbot_plugin_UnderstandAnything"
PLUGIN_DISPLAY_NAME = "Understand Anything"

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
UNDERSTAND_ANYTHING_ROOT = PLUGIN_ROOT / "understand-anything"
PLUGIN_SKILLS_ROOT = PLUGIN_ROOT / "skills"
AGENT_PROMPTS_ROOT = PLUGIN_ROOT / "astrbot_adapter" / "prompts" / "agents"
DASHBOARD_SOURCE_ROOT = UNDERSTAND_ANYTHING_ROOT / "packages" / "dashboard"
DASHBOARD_PAGE_ROOT = PLUGIN_ROOT / "pages" / "dashboard"

GRAPH_DIR_NAME = ".understand-anything"
MAX_SOURCE_FILE_BYTES = 1024 * 1024
UA_TOOL_CALL_TIMEOUT_SECONDS = 30 * 60

SKILL_COMMANDS = {
    "understand": "understand",
    "understand-dashboard": "understand-dashboard",
    "understand-chat": "understand-chat",
    "understand-diff": "understand-diff",
    "understand-domain": "understand-domain",
    "understand-explain": "understand-explain",
    "understand-knowledge": "understand-knowledge",
    "understand-onboard": "understand-onboard",
}

GRAPH_FILES = {
    "graph": "knowledge-graph.json",
    "meta": "meta.json",
    "domain-graph": "domain-graph.json",
    "diff-overlay": "diff-overlay.json",
}
