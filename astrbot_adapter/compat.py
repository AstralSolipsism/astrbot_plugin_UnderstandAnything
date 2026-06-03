from __future__ import annotations

import enum


if hasattr(enum, "StrEnum"):
    StrEnum = enum.StrEnum
else:
    class StrEnum(str, enum.Enum):
        def __str__(self) -> str:
            return str(self.value)
