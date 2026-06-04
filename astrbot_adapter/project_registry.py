from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .compat import StrEnum
from .constants import GRAPH_DIR_NAME, PLUGIN_NAME, PLUGIN_ROOT
from .path_security import PathSecurity


class ProjectRegistryError(ValueError):
    """Raised when a project reference cannot be resolved unambiguously."""


class ProjectStatus(StrEnum):
    EMPTY = "empty"
    CLONING = "cloning"
    ANALYZING = "analyzing"
    READY = "ready"
    STALE = "stale"
    FAILED = "failed"
    DELETING = "deleting"


_UNSET = object()


@dataclass(slots=True)
class ProjectRecord:
    project_id: str
    name: str
    aliases: list[str]
    path: str
    graph_root: str
    last_job_id: str | None = None
    last_analyzed_at: float | None = None
    auto_update: bool = False
    source: dict[str, Any] = field(default_factory=dict)
    status: ProjectStatus = ProjectStatus.EMPTY
    current_job_id: str | None = None
    last_error: str | None = None
    node_count: int = 0
    edge_count: int = 0
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ProjectRecord:
        now = time.time()
        return cls(
            project_id=str(payload.get("project_id") or ""),
            name=str(payload.get("name") or ""),
            aliases=[
                str(alias) for alias in payload.get("aliases", []) if str(alias).strip()
            ],
            path=str(payload.get("path") or ""),
            graph_root=str(payload.get("graph_root") or ""),
            last_job_id=(
                str(payload["last_job_id"])
                if payload.get("last_job_id") is not None
                else None
            ),
            last_analyzed_at=(
                float(payload["last_analyzed_at"])
                if payload.get("last_analyzed_at") is not None
                else None
            ),
            auto_update=bool(payload.get("auto_update", False)),
            source=(
                dict(payload.get("source"))
                if isinstance(payload.get("source"), dict)
                else {}
            ),
            status=_coerce_project_status(payload.get("status")),
            current_job_id=(
                str(payload["current_job_id"])
                if payload.get("current_job_id") is not None
                else (
                    str(payload["currentJobId"])
                    if payload.get("currentJobId") is not None
                    else None
                )
            ),
            last_error=(
                str(payload["last_error"])
                if payload.get("last_error") is not None
                else (
                    str(payload["lastError"])
                    if payload.get("lastError") is not None
                    else None
                )
            ),
            node_count=_int_payload_value(
                payload.get("node_count", payload.get("nodeCount", 0)),
            ),
            edge_count=_int_payload_value(
                payload.get("edge_count", payload.get("edgeCount", 0)),
            ),
            created_at=(
                float(payload["created_at"])
                if payload.get("created_at") is not None
                else now
            ),
            updated_at=(
                float(payload["updated_at"])
                if payload.get("updated_at") is not None
                else now
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        last_analyzed_iso = (
            _iso_from_timestamp(self.last_analyzed_at)
            if self.last_analyzed_at is not None
            else None
        )
        return {
            "id": self.project_id,
            "project_id": self.project_id,
            "name": self.name,
            "aliases": self.aliases,
            "path": self.path,
            "localPath": self.path,
            "graph_root": self.graph_root,
            "last_job_id": self.last_job_id,
            "last_analyzed_at": self.last_analyzed_at,
            "lastAnalyzedAt": last_analyzed_iso,
            "auto_update": self.auto_update,
            "autoUpdate": self.auto_update,
            "source": self.source,
            "status": self.status.value,
            "current_job_id": self.current_job_id,
            "currentJobId": self.current_job_id,
            "last_error": self.last_error,
            "lastError": self.last_error,
            "node_count": self.node_count,
            "nodeCount": self.node_count,
            "edge_count": self.edge_count,
            "edgeCount": self.edge_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "createdAt": _iso_from_timestamp(self.created_at),
            "updatedAt": _iso_from_timestamp(self.updated_at),
        }


@dataclass(slots=True)
class ProjectRegistry:
    storage_path: Path | None = None
    _records: dict[str, ProjectRecord] = field(default_factory=dict, init=False)
    _loaded: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        self._loaded = False
        if self.storage_path is None:
            self.storage_path = _default_storage_path()
        else:
            self.storage_path = Path(self.storage_path)

    def list(self) -> list[ProjectRecord]:
        self._load()
        return sorted(self._records.values(), key=lambda record: record.name.casefold())

    def register(
        self,
        project_root: str | Path,
        *,
        job_id: str | None = None,
        auto_update: bool | None = None,
        aliases: list[str] | None = None,
        graph_root: str | Path | None = None,
        source: dict[str, Any] | None = None,
        status: ProjectStatus | str | None = None,
    ) -> ProjectRecord:
        self._load()
        resolved = Path(project_root).expanduser().resolve(strict=False)
        resolved_graph_root = (
            Path(graph_root).expanduser().resolve(strict=False)
            if graph_root is not None
            else resolved / GRAPH_DIR_NAME
        )
        project_id = self.project_id_for(
            resolved if graph_root is None else resolved_graph_root.parent,
        )
        existing = self._records.get(project_id)
        name = self._project_name(resolved_graph_root) or resolved.name or project_id
        alias_values = set(existing.aliases if existing else [])
        alias_values.add(resolved.name)
        if existing and existing.name and existing.name != name:
            alias_values.add(existing.name)
        for alias in aliases or []:
            if alias.strip():
                alias_values.add(alias.strip())
        last_job_id = existing.last_job_id if existing else None
        last_analyzed_at = existing.last_analyzed_at if existing else None
        auto_update_value = existing.auto_update if existing else False
        source_value = existing.source if existing else {}
        existing_counts = _graph_counts(resolved_graph_root)
        status_value = (
            existing.status
            if existing
            else (
                ProjectStatus.READY
                if existing_counts is not None
                else ProjectStatus.EMPTY
            )
        )
        current_job_id = existing.current_job_id if existing else None
        last_error = existing.last_error if existing else None
        node_count = existing.node_count if existing else 0
        edge_count = existing.edge_count if existing else 0
        created_at = existing.created_at if existing else time.time()
        updated_at = time.time()
        if existing_counts is not None and not existing:
            node_count, edge_count = existing_counts
        if job_id is not None:
            last_job_id = job_id
        if auto_update is not None:
            auto_update_value = auto_update
        if source is not None:
            source_value = dict(source)
        if status is not None:
            status_value = _coerce_project_status(status)
            if status_value in {ProjectStatus.CLONING, ProjectStatus.ANALYZING}:
                current_job_id = job_id or current_job_id
                last_error = None
            elif status_value is ProjectStatus.READY:
                current_job_id = None
                last_error = None
                last_analyzed_at = time.time()
                if existing_counts is not None:
                    node_count, edge_count = existing_counts
        record = ProjectRecord(
            project_id=project_id,
            name=name,
            aliases=sorted(alias_values, key=str.casefold),
            path=str(resolved),
            graph_root=str(resolved_graph_root),
            last_job_id=last_job_id,
            last_analyzed_at=last_analyzed_at,
            auto_update=auto_update_value,
            source=source_value,
            status=status_value,
            current_job_id=current_job_id,
            last_error=last_error,
            node_count=node_count,
            edge_count=edge_count,
            created_at=created_at,
            updated_at=updated_at,
        )
        self._records[project_id] = record
        self._save()
        return record

    def update_status(
        self,
        project_id: str,
        status: ProjectStatus | str,
        *,
        current_job_id: str | None | object = _UNSET,
        last_job_id: str | None | object = _UNSET,
        last_error: str | None | object = _UNSET,
        last_analyzed_at: float | None | object = _UNSET,
        node_count: int | object = _UNSET,
        edge_count: int | object = _UNSET,
    ) -> ProjectRecord:
        self._load()
        record = self._records.get(project_id)
        if record is None:
            raise ProjectRegistryError(
                f"Unknown Understand Anything project: {project_id}. "
                f"Available projects: {self._available_projects_text()}",
            )
        status_value = _coerce_project_status(status)
        record.status = status_value
        if current_job_id is not _UNSET:
            record.current_job_id = (
                str(current_job_id) if current_job_id is not None else None
            )
        if last_job_id is not _UNSET:
            record.last_job_id = str(last_job_id) if last_job_id is not None else None
        if last_error is not _UNSET:
            record.last_error = str(last_error) if last_error is not None else None
        elif status_value is not ProjectStatus.FAILED:
            record.last_error = None
        if last_analyzed_at is not _UNSET:
            record.last_analyzed_at = (
                float(last_analyzed_at) if last_analyzed_at is not None else None
            )
        elif status_value is ProjectStatus.READY:
            record.last_analyzed_at = time.time()
        if node_count is not _UNSET:
            record.node_count = max(0, int(node_count))
        if edge_count is not _UNSET:
            record.edge_count = max(0, int(edge_count))
        if status_value in {ProjectStatus.CLONING, ProjectStatus.ANALYZING}:
            record.last_error = None
        if status_value in {ProjectStatus.READY, ProjectStatus.FAILED}:
            record.current_job_id = (
                None if current_job_id is _UNSET else record.current_job_id
            )
        record.updated_at = time.time()
        self._save()
        return record

    def resolve(
        self,
        security: PathSecurity,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_path: str | Path | None = None,
        project_ref: str | None = None,
    ) -> Path:
        if project_path:
            return security.resolve_project_path(project_path)

        ref = self._first_non_empty(project_id, project_name, project_ref)
        self._load()
        if ref:
            record = self._find(ref)
            if record is None:
                if self._looks_like_path(ref):
                    return security.resolve_project_path(ref)
                raise ProjectRegistryError(
                    f"Unknown Understand Anything project: {ref}. "
                    f"Available projects: {self._available_projects_text()}",
                )
            return security.resolve_project_path(record.path)

        records = self.list()
        if not records:
            raise ProjectRegistryError(
                "No Understand Anything projects are registered. "
                "Run /understand <path> first or pass an explicit project path.",
            )
        if len(records) > 1:
            raise ProjectRegistryError(
                "Multiple Understand Anything projects are registered. "
                "Specify --project <name|id|alias>. "
                f"Available projects: {self._available_projects_text()}",
            )
        return security.resolve_project_path(records[0].path)

    def resolve_record(
        self,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> ProjectRecord:
        ref = self._first_non_empty(project_id, project_name, project_ref)
        self._load()
        if ref:
            record = self._find(ref)
            if record is None:
                raise ProjectRegistryError(
                    f"Unknown Understand Anything project: {ref}. "
                    f"Available projects: {self._available_projects_text()}",
                )
            return record

        records = self.list()
        if not records:
            raise ProjectRegistryError(
                "No Understand Anything projects are registered. "
                "Run /understand <path> first or pass an explicit project path.",
            )
        if len(records) > 1:
            raise ProjectRegistryError(
                "Multiple Understand Anything projects are registered. "
                "Specify --project <name|id|alias>. "
                f"Available projects: {self._available_projects_text()}",
            )
        return records[0]

    @staticmethod
    def project_id_for(project_root: Path) -> str:
        key = str(project_root.resolve(strict=False)).casefold()
        return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]

    def _load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.storage_path is None or not self.storage_path.is_file():
            self._records = {}
            return
        try:
            payload = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._records = {}
            return
        items = payload.get("projects", []) if isinstance(payload, dict) else []
        records: dict[str, ProjectRecord] = {}
        for item in items:
            if not isinstance(item, dict):
                continue
            record = ProjectRecord.from_dict(item)
            if record.project_id and record.path:
                records[record.project_id] = record
        self._records = records

    def _save(self) -> None:
        if self.storage_path is None:
            return
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"projects": [record.to_dict() for record in self.list()]}
        self.storage_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _find(self, ref: str) -> ProjectRecord | None:
        normalized = ref.casefold()
        for record in self.list():
            candidates = {
                record.project_id,
                record.name,
                record.path,
                record.graph_root,
                str(Path(record.path).name),
                *(record.aliases or []),
            }
            if any(candidate.casefold() == normalized for candidate in candidates):
                return record
        return None

    def get(
        self,
        *,
        project_id: str | None = None,
        project_name: str | None = None,
        project_ref: str | None = None,
    ) -> ProjectRecord | None:
        ref = self._first_non_empty(project_id, project_name, project_ref)
        if not ref:
            records = self.list()
            return records[0] if len(records) == 1 else None
        return self._find(ref)

    def delete(self, project_id: str) -> ProjectRecord | None:
        self._load()
        record = self._records.pop(project_id, None)
        if record is not None:
            self._save()
        return record

    def _available_projects_text(self) -> str:
        records = self.list()
        if not records:
            return "none"
        return ", ".join(f"{record.name} ({record.project_id})" for record in records)

    @staticmethod
    def _project_name(graph_root: Path) -> str | None:
        graph_path = graph_root / "knowledge-graph.json"
        if not graph_path.is_file():
            return None
        try:
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(graph, dict):
            return None
        project = graph.get("project")
        if not isinstance(project, dict):
            return None
        name = project.get("name")
        return str(name).strip() if name else None

    @staticmethod
    def _first_non_empty(*values: str | None) -> str | None:
        for value in values:
            if value and str(value).strip():
                return str(value).strip()
        return None

    @staticmethod
    def _looks_like_path(value: str) -> bool:
        return (
            Path(value).is_absolute()
            or value.startswith((".", "~"))
            or "/" in value
            or "\\" in value
            or ":" in value
        )


def _default_storage_path() -> Path:
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_plugin_data_path

        return Path(get_astrbot_plugin_data_path()) / PLUGIN_NAME / "projects.json"
    except Exception:
        return PLUGIN_ROOT / ".plugin_data" / "projects.json"


def _coerce_project_status(value: Any) -> ProjectStatus:
    if isinstance(value, ProjectStatus):
        return value
    text = str(value or "").strip()
    if not text:
        return ProjectStatus.EMPTY
    try:
        return ProjectStatus(text)
    except ValueError:
        return ProjectStatus.EMPTY


def _graph_counts(graph_root: Path) -> tuple[int, int] | None:
    graph_path = graph_root / "knowledge-graph.json"
    if not graph_path.is_file():
        return None
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(graph, dict):
        return None
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    return (
        len(nodes) if isinstance(nodes, list) else 0,
        len(edges) if isinstance(edges, list) else 0,
    )


def _int_payload_value(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _iso_from_timestamp(value: float) -> str:
    return (
        datetime.fromtimestamp(value, timezone.utc)
        .isoformat()
        .replace(
            "+00:00",
            "Z",
        )
    )
