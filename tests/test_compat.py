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
