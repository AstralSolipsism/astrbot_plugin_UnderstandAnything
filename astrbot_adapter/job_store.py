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
    FINISHED = "finished"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(slots=True)
class JobSnapshot:
    job_id: str
    kind: str
    project_root: Path
    args: dict[str, Any]
    status: JobStatus = JobStatus.QUEUED
    logs: list[str] = field(default_factory=list)
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

    def mark_running(self, job_id: str) -> None:
        self._update(job_id, status=JobStatus.RUNNING)

    def mark_finished(self, job_id: str, result: dict[str, Any]) -> None:
        self._update(job_id, status=JobStatus.FINISHED, result=result, error=None)

    def mark_failed(self, job_id: str, error: str) -> None:
        self._update(job_id, status=JobStatus.FAILED, error=error)

    def append_log(self, job_id: str, message: str) -> None:
        job = self._require(job_id)
        job.logs.append(message)
        job.updated_at = time.time()

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
