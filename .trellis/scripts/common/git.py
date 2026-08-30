"""
Git command execution utility.

Single source of truth for running git commands across all Trellis scripts.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def run_git(
    args: list[str],
    cwd: Path | None = None,
    timeout: float | None = None,
) -> tuple[int, str, str]:
    """Run a git command and return (returncode, stdout, stderr).

    Uses UTF-8 encoding with -c i18n.logOutputEncoding=UTF-8 to ensure
    consistent output across all platforms (Windows, macOS, Linux). Callers
    may provide a timeout for best-effort probes; normal Git operations remain
    unbounded by default.
    """
    try:
        git_args = ["git", "-c", "i18n.logOutputEncoding=UTF-8"] + args
        result = subprocess.run(
            git_args,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except Exception as e:
        return 1, "", str(e)


def resolve_default_branch(repo_root: Path) -> str | None:
    """Resolve the repository's default branch (origin/HEAD target).

    Tries the local `refs/remotes/origin/HEAD` symbolic ref first (no
    network access), then falls back to `git remote show origin` (which
    may hit the network but also repairs a missing/stale symbolic-ref).
    Returns None when neither resolves, so callers can fall back to their
    own pre-existing behavior.
    """
    rc, out, _ = run_git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd=repo_root)
    if rc == 0 and out.strip():
        return out.strip().rsplit("/", 1)[-1]

    rc, out, _ = run_git(["remote", "show", "origin"], cwd=repo_root)
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("HEAD branch:"):
                branch = line.split(":", 1)[1].strip()
                if branch and branch != "(unknown)":
                    return branch

    return None


def branch_exists_locally(branch: str, repo_root: Path) -> bool:
    """Check whether a local branch ref exists in the repository."""
    if not branch:
        return False
    rc, _, _ = run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
        cwd=repo_root,
    )
    return rc == 0
