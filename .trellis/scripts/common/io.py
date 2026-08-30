"""
JSON file I/O utilities.

Provides read_json and write_json as the single source of truth
for JSON file operations across all Trellis scripts.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def read_json(path: Path) -> dict | None:
    """Read and parse a JSON file.

    Returns None if the file doesn't exist, is invalid JSON, or can't be read.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def write_json(path: Path, data: dict) -> bool:
    """Write dict to JSON file with pretty formatting.

    The write is atomic: content goes to a temp file in the same directory
    and is then renamed over the target. A crash or Ctrl-C mid-write leaves
    the existing file intact rather than truncated, so a corrupted task.json
    can never make a task silently vanish from `task.py list`.

    Returns True on success, False on error.
    """
    payload = json.dumps(data, indent=2, ensure_ascii=False)
    try:
        fd, tmp = tempfile.mkstemp(
            dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
        )
    except OSError:
        return False

    try:
        try:
            f = os.fdopen(fd, "w", encoding="utf-8")
        except OSError:
            # fdopen never took ownership of fd; close it ourselves.
            os.close(fd)
            raise
        with f:
            f.write(payload)
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False
