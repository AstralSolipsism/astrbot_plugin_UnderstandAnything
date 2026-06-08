from pathlib import Path
import sys

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT))

from astrbot_adapter.job_store import JobStatus
from astrbot_adapter.project_registry import ProjectStatus


def test_status_enums_behave_like_string_values() -> None:
    assert isinstance(JobStatus.RUNNING, str)
    assert isinstance(ProjectStatus.READY, str)
    assert str(JobStatus.RUNNING) == "running"
    assert str(ProjectStatus.READY) == "ready"


def test_understand_is_exposed_only_as_command_group() -> None:
    source = (PLUGIN_ROOT / "main.py").read_text(encoding="utf-8")

    assert '@filter.command_group("understand")' in source
    assert '@filter.command("understand")' not in source
    assert "@filter.command('understand')" not in source
    assert "async def understand(" not in source
    for subcommand in (
        "状态",
        "项目",
        "检查更新",
        "分析",
        "更新",
        "更新图谱",
        "重新分析",
        "停止",
        "诊断",
        "修复",
        "面板",
    ):
        assert f'.command("{subcommand}")' in source
