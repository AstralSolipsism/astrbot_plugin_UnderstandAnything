from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


@dataclass(frozen=True, slots=True)
class ParsedJobArgs:
    path: str | None
    project_ref: str | None
    flags: list[str]


def parse_job_args(raw_args: str) -> ParsedJobArgs:
    tokens = split_args(raw_args)
    flags: list[str] = []
    project_ref: str | None = None
    path_token: str | None = None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--project":
            if index + 1 >= len(tokens):
                raise ValueError("Missing value for --project.")
            project_ref = tokens[index + 1]
            index += 2
            continue
        if token.startswith("--project="):
            project_ref = token.split("=", 1)[1].strip()
            index += 1
            continue
        if token.startswith("--"):
            flags.append(token)
        elif path_token is None:
            path_token = token
        index += 1
    return ParsedJobArgs(path=path_token, project_ref=project_ref, flags=flags)


def format_job_args(project_root: Path, flags: Sequence[str] | None = None) -> str:
    parts = [quote_arg(str(project_root))]
    parts.extend(flags or [])
    return " ".join(parts)


def quote_arg(value: str) -> str:
    if value and not any(char.isspace() for char in value) and '"' not in value:
        return value
    return '"' + value.replace('"', '\\"') + '"'


def split_args(raw_args: str) -> list[str]:
    try:
        tokens = shlex.split(raw_args, posix=False)
    except ValueError:
        tokens = raw_args.split()
    return [token.strip("\"'") for token in tokens if token.strip("\"'")]
