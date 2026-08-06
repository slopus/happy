#!/usr/bin/env python3
"""Conservative disk cleanup for the Happy/Paws development repository."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Iterable


MAIN_BRANCH = "main"
FETCH_MAX_AGE_SECONDS = 6 * 60 * 60


class CleanupError(RuntimeError):
    pass


@dataclass(frozen=True)
class Worktree:
    path: Path
    head: str
    branch: str | None
    detached: bool


@dataclass(frozen=True)
class ProcessCwd:
    pid: int
    command: str
    path: Path


@dataclass(frozen=True)
class Candidate:
    worktree: Worktree
    pr_number: int
    pr_url: str
    pr_title: str


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            capture_output=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CleanupError(f"failed to run {' '.join(command)}: {exc}") from exc
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise CleanupError(f"{' '.join(command)} failed: {detail}")
    return result


def git(repo: Path, *args: str, check: bool = True) -> str:
    return run(["git", "-C", str(repo), *args], check=check).stdout.strip()


def human_bytes(value: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    sign = "-" if value < 0 else ""
    number = float(abs(value))
    for unit in units:
        if number < 1024 or unit == units[-1]:
            return f"{sign}{number:.1f} {unit}"
        number /= 1024
    return f"{sign}{number:.1f} TiB"


def disk_free(path: Path) -> int:
    return shutil.disk_usage(path).free


def apparent_size(path: Path) -> int:
    if not path.exists():
        return 0
    result = run(["du", "-sk", str(path)], check=False, timeout=60)
    if result.returncode != 0 or not result.stdout.strip():
        return 0
    try:
        return int(result.stdout.split()[0]) * 1024
    except (IndexError, ValueError):
        return 0


def parse_worktrees(repo: Path) -> list[Worktree]:
    output = git(repo, "worktree", "list", "--porcelain")
    worktrees: list[Worktree] = []
    for block in output.split("\n\n"):
        fields: dict[str, str] = {}
        detached = False
        for line in block.splitlines():
            if line == "detached":
                detached = True
                continue
            key, _, value = line.partition(" ")
            fields[key] = value
        if not fields.get("worktree") or not fields.get("HEAD"):
            continue
        branch_ref = fields.get("branch")
        branch = branch_ref.removeprefix("refs/heads/") if branch_ref else None
        path = Path(fields["worktree"]).expanduser()
        if not path.is_absolute():
            path = (repo / path).absolute()
        worktrees.append(Worktree(path, fields["HEAD"], branch, detached))
    return worktrees


def find_main_root(start: Path) -> tuple[Path, list[Worktree]]:
    repo = Path(git(start, "rev-parse", "--show-toplevel")).resolve()
    worktrees = parse_worktrees(repo)
    roots = [item.path for item in worktrees if item.branch == MAIN_BRANCH]
    if len(roots) != 1:
        raise CleanupError("expected exactly one worktree on main")
    root = roots[0]
    required = [root / "AGENTS.md", root / "CLAUDE.md", root / "packages" / "happy-cli"]
    if not all(path.exists() for path in required):
        raise CleanupError(f"{root} does not look like the Happy repository")
    return root, worktrees


def git_common_dir(root: Path) -> Path:
    value = Path(git(root, "rev-parse", "--git-common-dir"))
    if not value.is_absolute():
        value = root / value
    return value.resolve()


def root_guard(root: Path) -> list[str]:
    errors: list[str] = []
    if git(root, "branch", "--show-current") != MAIN_BRANCH:
        errors.append("root workspace is not on main")
    if git(root, "status", "--porcelain"):
        errors.append("root workspace is dirty")
    local_head = git(root, "rev-parse", "HEAD")
    remote_head = git(root, "rev-parse", "origin/main", check=False)
    if not remote_head:
        errors.append("origin/main is unavailable")
    elif local_head != remote_head:
        errors.append("root HEAD differs from origin/main")
    return errors


def fetch_is_recent(root: Path) -> tuple[bool, str]:
    fetch_head = git_common_dir(root) / "FETCH_HEAD"
    if not fetch_head.exists():
        return False, "FETCH_HEAD is missing"
    age = time.time() - fetch_head.stat().st_mtime
    if age > FETCH_MAX_AGE_SECONDS:
        return False, f"last fetch is {age / 3600:.1f} hours old"
    return True, f"last fetch is {age / 60:.0f} minutes old"


def origin_slug(root: Path) -> str:
    url = git(root, "remote", "get-url", "origin")
    patterns = [
        r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$",
        r"^([^/]+/[^/]+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1).removesuffix(".git")
    raise CleanupError(f"cannot derive GitHub repository from origin URL: {url}")


def github_prs(root: Path, disabled: bool) -> list[dict[str, object]]:
    if disabled:
        return []
    if shutil.which("gh") is None:
        raise CleanupError("gh is unavailable; worktree deletion is disabled")
    result = run(
        [
            "gh",
            "pr",
            "list",
            "--repo",
            origin_slug(root),
            "--state",
            "all",
            "--limit",
            "500",
            "--json",
            "number,title,state,mergedAt,headRefName,headRefOid,baseRefName,url",
        ],
        timeout=45,
    )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise CleanupError(f"invalid GitHub response: {exc}") from exc
    if not isinstance(data, list):
        raise CleanupError("unexpected GitHub response")
    return data


def process_cwds() -> tuple[list[ProcessCwd], bool]:
    if shutil.which("lsof") is None:
        return [], False
    result = run(["lsof", "-n", "-a", "-d", "cwd", "-Fpcn"], check=False, timeout=30)
    if result.returncode not in (0, 1):
        return [], False
    current_pid: int | None = None
    current_command = "unknown"
    records: list[ProcessCwd] = []
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            current_pid = int(line[1:])
        elif line.startswith("c"):
            current_command = line[1:]
        elif line.startswith("n") and current_pid is not None:
            records.append(ProcessCwd(current_pid, current_command, Path(line[1:])))
    return records, True


def process_commands() -> dict[int, str]:
    result = run(["ps", "ax", "-o", "pid=,command="], check=False)
    commands: dict[int, str] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) == 2 and parts[0].isdigit():
            commands[int(parts[0])] = parts[1]
    return commands


def is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve(strict=False).relative_to(parent.resolve(strict=False))
        return True
    except ValueError:
        return False


def active_in(path: Path, records: Iterable[ProcessCwd]) -> list[ProcessCwd]:
    return [record for record in records if is_within(record.path, path)]


def worktree_candidates(
    root: Path,
    worktrees: list[Worktree],
    prs: list[dict[str, object]],
    cwds: list[ProcessCwd],
    lsof_ok: bool,
    fetch_ok: bool,
) -> tuple[list[Candidate], list[tuple[Worktree, str]]]:
    candidates: list[Candidate] = []
    skipped: list[tuple[Worktree, str]] = []
    open_branches = {
        str(pr.get("headRefName")) for pr in prs if pr.get("state") == "OPEN"
    }
    merged_by_branch: dict[str, list[dict[str, object]]] = {}
    for pr in prs:
        if pr.get("state") == "MERGED" and pr.get("baseRefName") == MAIN_BRANCH:
            merged_by_branch.setdefault(str(pr.get("headRefName")), []).append(pr)

    for item in worktrees:
        if item.path == root:
            continue
        reason = ""
        if item.path.parent != root.parent or not item.path.name.startswith(f"{root.name}--"):
            reason = "outside the approved sibling worktree namespace"
        elif item.path.is_symlink():
            reason = "worktree path is a symlink"
        elif item.detached or not item.branch:
            reason = "detached worktree"
        elif not item.path.exists():
            reason = "path is missing"
        elif not fetch_ok:
            reason = "remote state is stale"
        elif not lsof_ok:
            reason = "live-process detection is unavailable"
        elif item.branch in open_branches:
            reason = "branch has an open PR"
        elif git(item.path, "status", "--porcelain"):
            reason = "worktree is dirty"
        elif active_in(item.path, cwds):
            reason = "live process is using this worktree"
        else:
            matching = [
                pr
                for pr in merged_by_branch.get(item.branch, [])
                if str(pr.get("headRefOid")) == item.head
            ]
            ancestor = run(
                ["git", "-C", str(root), "merge-base", "--is-ancestor", item.head, "origin/main"],
                check=False,
            ).returncode == 0
            if not matching:
                reason = "no exact merged GitHub PR head match"
            elif not ancestor:
                reason = "HEAD is not an ancestor of origin/main"
            else:
                pr = sorted(matching, key=lambda value: int(value.get("number", 0)))[-1]
                candidates.append(
                    Candidate(
                        item,
                        int(pr["number"]),
                        str(pr.get("url", "")),
                        str(pr.get("title", "")),
                    )
                )
                continue
        skipped.append((item, reason))
    return candidates, skipped


def has_process_matching(commands: Iterable[str], pattern: str) -> bool:
    expression = re.compile(pattern, re.IGNORECASE)
    return any(expression.search(command) for command in commands)


def clear_directory_contents(path: Path, allowed: set[Path]) -> tuple[int, list[str]]:
    normalized = path.expanduser().resolve(strict=False)
    if normalized not in allowed:
        raise CleanupError(f"cache path is not allowlisted: {normalized}")
    if path.is_symlink():
        raise CleanupError(f"refusing symlink cache path: {path}")
    if not path.exists():
        return 0, []
    before = apparent_size(path)
    failures: list[str] = []
    for child in list(path.iterdir()):
        try:
            if child.is_symlink() or child.is_file():
                child.unlink()
            else:
                shutil.rmtree(child)
        except OSError as exc:
            failures.append(f"{child}: {exc}")
    after = apparent_size(path)
    return max(0, before - after), failures


def orphaned_deleted_handles(root: Path) -> list[tuple[int, str, int, str]]:
    if shutil.which("lsof") is None:
        return []
    result = run(["lsof", "-n", "+L1", "-Fpcsn"], check=False, timeout=30)
    current_pid: int | None = None
    command = "unknown"
    size = 0
    found: set[tuple[int, str, int, str]] = set()
    marker = f"{root.name}--"
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            current_pid = int(line[1:])
            command = "unknown"
            size = 0
        elif line.startswith("c"):
            command = line[1:]
        elif line.startswith("s") and line[1:].isdigit():
            size = int(line[1:])
        elif line.startswith("n") and current_pid is not None:
            name = line[1:]
            if marker in name and not Path(name).exists():
                found.add((current_pid, command, size, name))
    return sorted(found, key=lambda value: value[2], reverse=True)


def remove_candidates(root: Path, candidates: list[Candidate]) -> list[str]:
    actions: list[str] = []
    for candidate in candidates:
        item = candidate.worktree
        if root_guard(root):
            raise CleanupError("root guard failed during cleanup")
        current_cwds, lsof_ok = process_cwds()
        if not lsof_ok or active_in(item.path, current_cwds):
            actions.append(f"SKIP {item.path}: process state changed")
            continue
        if not item.path.exists() or item.path.is_symlink():
            actions.append(f"SKIP {item.path}: path state changed")
            continue
        if git(item.path, "status", "--porcelain"):
            actions.append(f"SKIP {item.path}: became dirty")
            continue
        if git(item.path, "rev-parse", "HEAD") != item.head:
            actions.append(f"SKIP {item.path}: HEAD changed")
            continue
        result = run(
            ["git", "-C", str(root), "worktree", "remove", str(item.path)],
            check=False,
            timeout=300,
        )
        if result.returncode != 0:
            actions.append(f"SKIP {item.path}: git worktree remove failed")
            continue
        branch_result = run(
            ["git", "-C", str(root), "branch", "-d", item.branch or ""],
            check=False,
        )
        suffix = " and local branch" if branch_result.returncode == 0 else " (branch retained)"
        actions.append(f"REMOVED PR #{candidate.pr_number} worktree {item.path}{suffix}")
    run(["git", "-C", str(root), "worktree", "prune"], check=False)
    return actions


def clean_caches(
    root: Path,
    cwds: list[ProcessCwd],
    commands: dict[int, str],
    lsof_ok: bool,
) -> list[str]:
    actions: list[str] = []
    home = Path.home().resolve()
    gradle_cache = home / ".gradle" / "caches"
    pnpm_cache = home / "Library" / "Caches" / "pnpm"
    npm_cache = home / ".npm" / "_cacache"
    allowed = {path.resolve(strict=False) for path in (gradle_cache, pnpm_cache, npm_cache)}
    command_values = list(commands.values())
    gradle_active = has_process_matching(command_values, r"(?:^|[ /])(gradle|java)(?:$|[ /])|GradleDaemon")
    active_happy_pnpm = not lsof_ok or any(
        is_within(record.path, root.parent)
        and root.name in str(record.path)
        and "pnpm" in commands.get(record.pid, "").lower()
        for record in cwds
    )
    npm_active = has_process_matching(command_values, r"(?:^|[ /])(npm|npx)(?:$|[ /])")

    cache_jobs = [
        (gradle_cache, "Gradle cache", gradle_active),
        (pnpm_cache, "pnpm application cache", active_happy_pnpm),
        (npm_cache, "npm content cache", npm_active),
    ]
    for path, label, blocked in cache_jobs:
        if blocked:
            actions.append(f"SKIP {label}: related process is active")
            continue
        try:
            freed, failures = clear_directory_contents(path, allowed)
            actions.append(f"CLEARED {label}: apparent {human_bytes(freed)}")
            if failures:
                actions.append(f"  retained {len(failures)} protected entries")
        except CleanupError as exc:
            actions.append(f"SKIP {label}: {exc}")

    if active_happy_pnpm:
        actions.append("SKIP pnpm store prune: Happy pnpm process is active")
    elif shutil.which("pnpm") is None:
        actions.append("SKIP pnpm store prune: pnpm is unavailable")
    else:
        result = run(["pnpm", "store", "prune"], cwd=root, check=False, timeout=300)
        if result.returncode == 0:
            summary = "; ".join(line for line in result.stdout.splitlines() if line.strip())
            actions.append(f"PRUNED pnpm store: {summary or 'complete'}")
        else:
            actions.append("SKIP pnpm store prune: command failed")
    return actions


def cache_inventory() -> list[tuple[str, Path, int]]:
    home = Path.home()
    paths = [
        ("Gradle cache", home / ".gradle" / "caches"),
        ("pnpm application cache", home / "Library" / "Caches" / "pnpm"),
        ("npm content cache", home / ".npm" / "_cacache"),
        ("pnpm store", Path(run(["pnpm", "store", "path"]).stdout.strip()) if shutil.which("pnpm") else Path("/nonexistent")),
    ]
    return [(label, path, apparent_size(path)) for label, path in paths]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="Any worktree in the Happy repository")
    parser.add_argument("--apply-safe", action="store_true", help="Apply only allowlisted safe cleanup actions")
    parser.add_argument("--skip-worktrees", action="store_true", help="Do not inspect or remove worktrees")
    parser.add_argument("--skip-caches", action="store_true", help="Do not inspect or clear caches")
    parser.add_argument("--no-github", action="store_true", help="Disable GitHub lookup; worktree removal will be unavailable")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        root, worktrees = find_main_root(args.repo.expanduser().resolve())
        guards = root_guard(root)
        fetch_ok, fetch_detail = fetch_is_recent(root)
        cwds, lsof_ok = process_cwds()
        commands = process_commands()
        free_before = disk_free(root)

        print(f"Happy space cleanup: {'APPLY SAFE' if args.apply_safe else 'DRY RUN'}")
        print(f"root: {root}")
        print(f"disk free before: {human_bytes(free_before)}")
        print(f"root guard: {'PASS' if not guards else 'FAIL - ' + '; '.join(guards)}")
        print(f"remote freshness: {'PASS' if fetch_ok else 'FAIL'} - {fetch_detail}")
        print(f"live-process detection: {'PASS' if lsof_ok else 'FAIL'}")

        candidates: list[Candidate] = []
        skipped: list[tuple[Worktree, str]] = []
        if not args.skip_worktrees:
            try:
                prs = github_prs(root, args.no_github)
                candidates, skipped = worktree_candidates(root, worktrees, prs, cwds, lsof_ok, fetch_ok)
            except CleanupError as exc:
                print(f"worktree verification unavailable: {exc}")
            print(f"verified merged worktree candidates: {len(candidates)}")
            for candidate in candidates:
                print(f"  PR #{candidate.pr_number}: {candidate.worktree.path} [{candidate.worktree.branch}]")
            reason_counts: dict[str, int] = {}
            for _, reason in skipped:
                reason_counts[reason] = reason_counts.get(reason, 0) + 1
            if reason_counts:
                print("protected worktrees:")
                for reason, count in sorted(reason_counts.items()):
                    print(f"  {count} - {reason}")

        if not args.skip_caches:
            print("allowlisted cache inventory (apparent sizes):")
            for label, path, size in cache_inventory():
                print(f"  {label}: {human_bytes(size)} [{path}]")

        handles = orphaned_deleted_handles(root)
        if handles:
            print("deleted Happy files still held open (report only):")
            for pid, command, size, name in handles[:10]:
                print(f"  pid={pid} command={command} size={human_bytes(size)} path={name}")

        if args.apply_safe:
            if guards:
                raise CleanupError("refusing apply-safe because the root guard failed")
            actions: list[str] = []
            if not args.skip_worktrees:
                actions.extend(remove_candidates(root, candidates))
            if not args.skip_caches:
                current_cwds, current_lsof_ok = process_cwds()
                actions.extend(
                    clean_caches(root, current_cwds, process_commands(), current_lsof_ok)
                )
            print("actions:")
            for action in actions:
                print(f"  {action}")

        free_after = disk_free(root)
        print(f"disk free after: {human_bytes(free_after)}")
        print(f"observed free-space delta during run: {human_bytes(free_after - free_before)}")
        final_guards = root_guard(root)
        print(f"final root guard: {'PASS' if not final_guards else 'FAIL - ' + '; '.join(final_guards)}")
        return 0 if not final_guards else 2
    except CleanupError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
