from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .compat import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_CONFIRMATION = "waiting_confirmation"
    FINISHED = "finished"
    FAILED = "failed"
    CANCELLED = "cancelled"


PROGRESS_PHASES: tuple[tuple[str, str, int], ...] = (
    ("queued", "Queued", 0),
    ("source", "Preparing source", 15),
    ("confirmation", "Prepare scan rules", 20),
    ("runtime", "Preparing runtime", 30),
    ("agent", "Running analysis", 55),
    ("validate", "Validating outputs", 85),
    ("complete", "Complete", 100),
)

TERMINAL_JOB_STATUSES = {
    JobStatus.FINISHED,
    JobStatus.FAILED,
    JobStatus.CANCELLED,
}
MAX_JOB_OBSERVATIONS = 160


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
class JobObservation:
    id: str
    timestamp: str
    kind: str
    level: str
    title: str
    message: str
    stage: str | None = None
    status: str | None = None
    details: dict[str, Any] | None = None

    @classmethod
    def create(
        cls,
        *,
        kind: str,
        level: str,
        title: str,
        message: str,
        stage: str | None = None,
        status: str | None = None,
        details: dict[str, Any] | None = None,
        observation_id: str | None = None,
        timestamp: str | None = None,
    ) -> JobObservation:
        return cls(
            id=observation_id or uuid.uuid4().hex,
            timestamp=timestamp or _now_iso(),
            kind=str(kind),
            level=str(level),
            title=str(title),
            message=str(message),
            stage=str(stage) if stage is not None else None,
            status=str(status) if status is not None else None,
            details=dict(details) if details is not None else None,
        )

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "timestamp": self.timestamp,
            "createdAt": self.timestamp,
            "kind": self.kind,
            "level": self.level,
            "title": self.title,
            "message": self.message,
        }
        if self.stage is not None:
            payload["stage"] = self.stage
        if self.status is not None:
            payload["status"] = self.status
        if self.details is not None:
            payload["details"] = self.details
        return payload


@dataclass(slots=True)
class JobSnapshot:
    job_id: str
    kind: str
    project_root: Path
    args: dict[str, Any]
    status: JobStatus = JobStatus.QUEUED
    logs: list[str] = field(default_factory=list)
    progress: JobProgress = field(default_factory=JobProgress.create)
    observations: list[JobObservation] = field(default_factory=list)
    confirmation: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        terminal = self.status in TERMINAL_JOB_STATUSES
        duration_ms = max(0, int((self.updated_at - self.created_at) * 1000))
        return {
            "id": self.job_id,
            "job_id": self.job_id,
            "kind": self.kind,
            "project_root": str(self.project_root),
            "args": self.args,
            "status": self.status.value,
            "terminal": terminal,
            "stage": self.progress.phase,
            "logs": self.logs,
            "recentLogs": self.logs[-80:],
            "progress": self.progress.to_dict(),
            "observations": [
                observation.to_dict() for observation in self.observations
            ],
            "confirmation": self.confirmation,
            "result": self.result,
            "summary": self._summary(),
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "startedAt": _iso_from_timestamp(self.created_at),
            "endedAt": _iso_from_timestamp(self.updated_at) if terminal else None,
            "durationMs": duration_ms,
        }

    def _summary(self) -> str | None:
        if self.result is None:
            return None
        message = self.result.get("message")
        return str(message) if message is not None else None


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
            job_id, "confirmation", "Preparing scan rules.", 20
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
        self.append_observation(
            job_id,
            kind="success",
            level="success",
            title="任务完成",
            message="Understand Anything 分析已完成。",
            stage="complete",
            status="completed",
        )

    def mark_failed(self, job_id: str, error: str) -> None:
        failed_stage = self._last_observation_stage(job_id) or self._require(
            job_id
        ).progress.phase
        self.set_progress(job_id, "failed", "Analysis failed.", 100)
        self._update(job_id, status=JobStatus.FAILED, error=error)
        self.append_observation(
            job_id,
            kind="error",
            level="error",
            title="任务失败",
            message=error,
            stage=failed_stage,
            status="failed",
        )

    def mark_cancelled(self, job_id: str, error: str = "Job cancelled.") -> None:
        cancelled_stage = self._last_observation_stage(job_id) or self._require(
            job_id
        ).progress.phase
        self.set_progress(job_id, "cancelled", "Analysis cancelled.", 100)
        self._update(job_id, status=JobStatus.CANCELLED, error=error)
        self.append_observation(
            job_id,
            kind="warning",
            level="warning",
            title="任务取消",
            message=error,
            stage=cancelled_stage,
            status="cancelled",
        )

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

    def append_observation(
        self,
        job_id: str,
        *,
        kind: str,
        level: str,
        title: str,
        message: str,
        stage: str | None = None,
        status: str | None = None,
        details: dict[str, Any] | None = None,
        observation_id: str | None = None,
    ) -> JobObservation:
        job = self._require(job_id)
        existing_index = (
            next(
                (
                    index
                    for index, observation in enumerate(job.observations)
                    if observation.id == observation_id
                ),
                None,
            )
            if observation_id is not None
            else None
        )
        existing = (
            job.observations[existing_index]
            if existing_index is not None
            else None
        )
        observation = JobObservation.create(
            kind=kind,
            level=level,
            title=title,
            message=message,
            stage=stage,
            status=status,
            details=details,
            observation_id=observation_id,
            timestamp=existing.timestamp if existing is not None else None,
        )
        if existing_index is None:
            job.observations.append(observation)
        else:
            job.observations[existing_index] = observation
        if len(job.observations) > MAX_JOB_OBSERVATIONS:
            job.observations = job.observations[-MAX_JOB_OBSERVATIONS:]
        job.updated_at = time.time()
        return observation

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

    def _last_observation_stage(self, job_id: str) -> str | None:
        job = self._require(job_id)
        for observation in reversed(job.observations):
            if observation.stage:
                return observation.stage
        return None


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


def _now_iso() -> str:
    return _iso_from_timestamp(time.time())


def _iso_from_timestamp(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace(
        "+00:00",
        "Z",
    )
