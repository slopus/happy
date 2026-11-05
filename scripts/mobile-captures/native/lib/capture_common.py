"""Shared pieces of the native capture drivers: refusing to touch a real checkout,
new-only result folders, hashes and a small JSON log."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path


def capture_copy(repo: str | Path, allow_checkout: bool = False) -> Path:
    """The capture copy of the repository. Installers change it (fixture harness, test files),
    so a Git checkout is refused unless asked for: sync a copy with `remote-*.sh` first."""
    path = Path(repo).expanduser().resolve()
    if not (path / 'packages').is_dir():
        raise SystemExit(f'{path}: not a Happy repository copy (no packages/)')
    if (path / '.git').exists() and not allow_checkout:
        raise SystemExit(f'{path} is a Git checkout. Capture installs fixture code into the tree it is given; '
                         'run it on a synced copy (see native/README.md) or pass --allow-checkout.')
    return path


def new_folder(path: str | Path) -> Path:
    """A results folder that did not exist before; earlier results are never reused or replaced."""
    out = Path(path).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir()
    return out


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hashes(folder: Path, pattern: str = '*.png') -> dict[str, str]:
    return {p.relative_to(folder).as_posix(): sha256(p) for p in sorted(folder.rglob(pattern))}


def run(*cmd, check: bool = True, **kw) -> subprocess.CompletedProcess:
    print('+', ' '.join(map(str, cmd)), flush=True)
    return subprocess.run([str(c) for c in cmd], check=check, **kw)


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, default=str) + '\n')


def need(*tools: str) -> None:
    missing = [t for t in tools if shutil.which(t) is None]
    if missing:
        sys.exit(f'missing tools: {", ".join(missing)}')


class Record(dict):
    """capture.json: what ran, with which inputs and processes, and how it ended."""

    def __init__(self, out: Path, **fields):
        super().__init__(started=time.time(), **fields)
        self.out = out

    def save(self, **fields) -> None:
        self.update(fields)
        write_json(self.out / 'capture.json', self)
