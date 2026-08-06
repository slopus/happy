---
name: happy-space-cleanup
description: Safely inspect and reclaim disk space used by the Happy/Paws repository on this Mac. Use for requests such as “清理 happy 空间”, “Happy 占满磁盘了”, “清理已合并 PR/worktree”, “释放 Happy 开发缓存”, or when low disk space is caused by Happy worktrees, pnpm, npm, Gradle, build caches, or orphaned Happy development processes.
---

# Happy Space Cleanup

Reclaim space conservatively. Treat source code, user artifacts, active sessions, and uncommitted changes as irreplaceable; treat verified merged worktrees and allowlisted build caches as rebuildable.

## Run the safe workflow

1. Read the repository root `AGENTS.md` and `CLAUDE.md` completely.
2. Keep `~/jacky-github/happy` on a clean `main` exactly aligned with `origin/main`. Never develop or leave cleanup artifacts in the root workspace.
3. Inspect before changing anything:

   ```bash
   python3 .agents/skills/happy-space-cleanup/scripts/cleanup.py \
     --repo ~/jacky-github/happy
   ```

4. If worktree cleanup is possible, refresh GitHub state first. Follow the available networking skill, then run:

   ```bash
   git -C ~/jacky-github/happy fetch origin --prune
   python3 .agents/skills/happy-space-cleanup/scripts/cleanup.py \
     --repo ~/jacky-github/happy --apply-safe
   ```

   A direct request such as “清理 happy 空间” authorizes `--apply-safe` after the dry run in the same turn. Do not ask again for allowlisted actions. Ask before any broader cleanup.

5. Report actual filesystem space before and after, not summed `du` estimates. pnpm hard links and APFS clones make apparent directory sizes misleading.
6. Recheck root status, `HEAD == origin/main`, remaining worktrees, and large deleted-but-open files.

## Automatic deletion boundary

The bundled script may remove a worktree only when all conditions hold:

- it is a sibling named `happy--*`, never the root workspace;
- GitHub reports a matching PR head commit as merged into `main` and no PR for that branch is open;
- its `HEAD` is an ancestor of `origin/main`;
- it has no tracked, staged, or untracked changes;
- it is attached to a named local branch, not detached;
- no live process has a working directory inside it;
- remote state was fetched recently;
- the path is not a symlink.

Delete only the local worktree and its safely merged local branch. Never delete a remote branch automatically.

The script may clear only these rebuildable caches:

- `~/.gradle/caches`, when no Java or Gradle process is running;
- `~/Library/Caches/pnpm`, when no Happy pnpm process is running;
- `~/.npm/_cacache`, when no npm/npx process is running;
- unreferenced pnpm store packages via `pnpm store prune`, when no Happy pnpm process is running.

## Hard protections

Never automatically delete or modify:

- dirty, detached, active, unverified, or open-PR worktrees;
- `Downloads`, `.Trash`, `.happy`, `.codex`, generated images, media, databases, secrets, credentials, or application support data;
- WeChat, browser, Cursor/ShipIt, Codex runtime, Docker/Colima, simulator, or global application caches;
- arbitrary ignored files via `git clean`, broad globs, or unresolved environment variables;
- root `node_modules`, Happy CLI `dist`, or anything used by the daemon;
- Time Machine/APFS snapshots.

Never run `happy daemon stop/start/restart` during cleanup. If daemon work is separately required, use `/Users/jacky/.local/bin/happy-daemon-rc` and perform every mandated health check from the repository instructions.

## Orphan process handling

The script only reports processes holding deleted Happy files; it does not terminate them. Before sending `TERM`, verify all of the following manually:

- the referenced worktree path no longer exists;
- the process is a development/test server, not Happy daemon, v2ray, or an agent session;
- its parent is PID 1 or its original task is known to be finished;
- stopping it will not interrupt another active task.

Use `TERM`, wait, and verify exit. Do not jump directly to `KILL`.

## When safe cleanup is insufficient

Stop after allowlisted cleanup. Present retained categories and ask before touching app caches, user artifacts, active build outputs, or unrelated repositories. Prefer options such as “close related apps and clean their caches”, “inspect other large directories”, or “stop here”.
