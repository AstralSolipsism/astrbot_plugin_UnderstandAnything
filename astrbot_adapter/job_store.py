from __future__ import annotations

import enum
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


class JobStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_CONFIRMATION = "waiting_confirmation"
    FINISHED = "finished"
    FAILED = "failed"
    CANCELLED = "cancelled"


PROGRESS_PHASES: tuple[tuple[str, str, int], ...] = (
    ("queued", "Queued", 0),
    ("source", "Preparing source", 15),
    ("confirmation", "Confirm scan scope", 20),
    ("runtime", "Preparing runtime", 30),
    ("agent", "Running analysis", 55),
    ("validate", "Validating outputs", 85),
    ("complete", "Complete", 100),
)


@dataclass(slots=True)
class JobProgress:
    phase: str
    label: str
    percent: int
    steps: list[dict[str, Any]]
    updated_at: float = field(default_factory=time.time)

    @classmethod
    def create(
        cls,
        phase: str = "queued",
        label: str | None = None,
        percent: int | None = None,
    ) -> JobProgress:
        default_percent = _phase_percent(phase)
        return cls(
            phase=phase,
            label=label or _phase_label(phase),
            percent=_clamp_percent(default_percent if percent is None else percent),
            steps=_progress_steps(phase),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "label": self.label,
            "percent": self.percent,
            "steps": self.steps,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class JobSnapshot:
    job_id: str
    kind: str
    project_root: Path
    args: dict[str, Any]
    status: JobStatus = JobStatus.QUEUED
    logs: list[str] = field(default_factory=list)
    progress: JobProgress = field(default_factory=JobProgress.create)
    confirmation: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "project_root": str(self.project_root),
            "args": self.args,
            "status": self.status.value,
            "logs": self.logs,
            "progress": self.progress.to_dict(),
            "confirmation": self.confirmation,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, JobSnapshot] = {}

    def create(
        self, kind: str, project_root: Path, args: dict[str, Any]
    ) -> JobSnapshot:
        job = JobSnapshot(
            job_id=uuid.uuid4().hex,
            kind=kind,
            project_root=project_root,
            args=args,
        )
        self._jobs[job.job_id] = job
        return job

    def list(self) -> list[JobSnapshot]:
        return sorted(self._jobs.values(), key=lambda job: job.created_at, reverse=True)

    def get(self, job_id: str) -> JobSnapshot | None:
        return self._jobs.get(job_id)

    def mark_queued(self, job_id: str) -> None:
        self.set_progress(job_id, "queued", "Queued for analysis.", 20)
        self._update(job_id, status=JobStatus.QUEUED)

    def mark_running(self, job_id: str) -> None:
        self._update(job_id, status=JobStatus.RUNNING)

    def mark_waiting_confirmation(
        self,
        job_id: str,
        confirmation: dict[str, Any],
    ) -> None:
        self.set_progress(
            job_id, "confirmation", "Waiting for scan scope confirmation.", 20
        )
        self._update(
            job_id,
            status=JobStatus.WAITING_CONFIRMATION,
            confirmation=confirmation,
        )

    def clear_confirmation(self, job_id: str) -> None:
        self._update(job_id, confirmation=None)

    def mark_finished(self, job_id: str, result: dict[str, Any]) -> None:
        self.set_progress(job_id, "complete", "Analysis complete.", 100)
        self._update(job_id, status=JobStatus.FINISHED, result=result, error=None)

    def mark_failed(self, job_id: str, error: str) -> None:
        self.set_progress(job_id, "failed", "Analysis failed.", 100)
        self._update(job_id, status=JobStatus.FAILED, error=error)

    def mark_cancelled(self, job_id: str, error: str = "Job cancelled.") -> None:
        self.set_progress(job_id, "cancelled", "Analysis cancelled.", 100)
        self._update(job_id, status=JobStatus.CANCELLED, error=error)

    def append_log(self, job_id: str, message: str) -> None:
        job = self._require(job_id)
        job.logs.append(message)
        job.updated_at = time.time()

    def set_progress(
        self,
        job_id: str,
        phase: str,
        label: str | None = None,
        percent: int | None = None,
    ) -> None:
        job = self._require(job_id)
        job.progress = JobProgress.create(phase, label, percent)
        job.updated_at = job.progress.updated_at

    def _update(self, job_id: str, **changes: Any) -> None:
        job = self._require(job_id)
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = time.time()

    def _require(self, job_id: str) -> JobSnapshot:
        job = self.get(job_id)
        if job is None:
            raise KeyError(f"Unknown job id: {job_id}")
        return job


def _phase_label(phase: str) -> str:
    for known_phase, label, _percent in PROGRESS_PHASES:
        if known_phase == phase:
            return label
    return phase.replace("_", " ").title()


def _phase_percent(phase: str) -> int:
    for known_phase, _label, percent in PROGRESS_PHASES:
        if known_phase == phase:
            return percent
    if phase in {"failed", "cancelled"}:
        return 100
    return 0


def _progress_steps(phase: str) -> list[dict[str, Any]]:
    active_index = next(
        (
            index
            for index, (known_phase, _label, _percent) in enumerate(PROGRESS_PHASES)
            if known_phase == phase
        ),
        None,
    )
    if phase in {"failed", "cancelled"}:
        active_index = len(PROGRESS_PHASES) - 1

    steps: list[dict[str, Any]] = []
    for index, (known_phase, label, _percent) in enumerate(PROGRESS_PHASES):
        if active_index is None:
            state = "pending"
        elif phase in {"failed", "cancelled"} and index == active_index:
            state = phase
        elif index < active_index:
            state = "complete"
        elif index == active_index:
            state = "active"
        else:
            state = "pending"
        steps.append({"phase": known_phase, "label": label, "status": state})
    return steps


def _clamp_percent(value: int) -> int:
    return max(0, min(100, int(value)))
