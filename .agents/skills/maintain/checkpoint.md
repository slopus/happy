# Triage Checkpoint

## Last triage: 2026-04-14

### Counts
- Open issues: 394
- Open PRs: 156
- Closed this session: ~110 (77 dupes + 33 stale)

## Milestones (priority order)

1. **table stakes** — devs use it daily and don't want to kill
   themselves. critical bugs, UX blockers, polish.
2. **growth** — viral features, community, social, engagement.
   anything that makes happy spread. may spin off per-feature
   milestones later.
3. **devx** — how hard is it to build a new feature? env setup,
   e2e testing, docs/skills hygiene, reducing friction for
   contributors. increases throughput on everything above.
4. **reliability** — sync, error reporting, alerting, resilience.
5. **orchestration** — cross-machine sync, session spawning/forking,
   resume, handoff between devices.
6. **agent-integrations** — new agent CLIs (copilot, cursor, etc),
   SDK updates, making agents spawnable from mobile/web.

Not milestones (tracked, not focus areas):
- voice — voice assistant reliability, TTS, BYOA config
- self-hosting — community-driven, stashed
- distribution — APK, homebrew, native binary

## Canonical Issues (by priority)

### P0 — blocks daily use
- #613 — terminal garbled after mode switch (PR #430)
- #682 — CLAUDECODE env poisons daemon sessions (PR #736)
- #528 — --settings clobbers user settings (no PR)
- #106 — auth expiry shows raw 401 JSON (no PR)
- #837 — codex first mobile message parse error (no PR)
- #685 — session resume from mobile (no PR, needs design)
- #102 — cross-device sync broken (no PR)
- #652 — context limit dead-end, no compact button (partial)

### P1 — important, workaround exists
- #648 — YOLO not persisted mid-session (PR #689)
- #966 — session rename (PRs #1049, #937, #908)
- #165 — co-authored-by: wrong email + no UI (partial)
- #36 — QR scanner needs google play (no PR)
- #156 — mandarin TTS mapped to cantonese (ElevenLabs limit)
- #145 — copilot CLI via ACP (PR #1034)
- #248 — cursor CLI (no code yet, acp fallback works)
- #358 — codex TUI non-interactive (by design, needs docs)
- #25 — android APK release (PR #278)

### P2 — nice to have
- #505 — bulk session delete (no PR)
- #719 — native binary install (homebrew tap closed)

## Resolved this session
- #824 — todos.filter crash (fixed via SessionRowData refactor)
- #265 — opencode support (shipped via ACP)
- #619 — MCP SDK 500 (fixed, per-request transport rewrite)
- ~77 duplicate issues closed with custom comments
- ~33 stale issues closed (old, no body, no follow-up)

## Quick-win PRs ready to review
- PR #736 → #682 (strip CLAUDECODE env, 5 spawn paths)
- PR #689 → #648 (one-liner: sync.applySettings on perm change)
- PR #1034 → #145 (copilot CLI via ACP, follows gemini pattern)

## Needs my response (remaining)
- #882 — Copilot CLI compat (Apr 4) — closed as dupe of #145
- #375 — askUserQuestion — likely fixed on main, verify (Feb 28)
- #54 — Voice on self-hosted (Sep '25)

## Notes
- npm `happy` package donated by @franciscop (issue #880)
- PR #803 is NOT needed for mobile askUserQuestion flow
- ACP agent detection is hardcoded per-agent (6-7 touch points)
- v1.7.0 native shipped ~2 weeks ago, multiple OTAs since
- GPT 5.2 is a real model (corrected)
