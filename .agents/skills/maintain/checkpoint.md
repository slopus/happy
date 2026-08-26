# Triage Checkpoint

## Last triage: 2026-08-25 (post CLI 1.2.1 / production OTA b16b23c5)

### This session
- Closed as fixed with comments: #1706, #1646, #1444, #1546, #1375,
  #1721, #1492, #1450 (partial: per-project defaults not built),
  #648, #375
- Closed PR without merging: #1447 (superseded by merged #1562)
- Commented, kept open pending reporter verification: #1716 (P0,
  labeled bug), #1695, #1679
- Commented, kept open as tracked work: #1707 (pinning UX, mobile
  first), #1631 (OpenCode first-class), #145 (Copilot)
- All claims verified against source, the cli-1.2.1 tag, and the
  production Expo OTA (buildCommitSha b16b23c5) before posting

### Pending follow-ups
- #1716: waiting on reporter after 07732a97; root cause only
  partially explained (auto-mode drop explains a vanished prompt,
  not one routed to the latest session). If they confirm, close;
  if not, reproduce with their platform/version answers.
- #1695, #1679: close once reporters confirm.
- #1450: per-project defaults intentionally not built; reporter was
  asked to file a separate issue if wanted.
- #1707: waiting on contributor screen recordings (two variants)
  before any pinning implementation review.
- Project board Priority/Size fields could NOT be set: gh token
  lacks read:project. Wanted: #1716 P0/S, #1707 P1/M, #1631 P1/M,
  #145 P1/L.
- Product note: do not ask contributors to target Happy Desktop yet
  (too raw); frame scope as native mobile, web deprioritized, and do
  not mention desktop in public comments.
- Local-only code change awaiting release: auto is the new code
  default permission mode (c7090622 on local main, f64a36be on
  worktree/triage-pinning-reordering); old CLIs degrade to
  `default`, user overrides untouched. Once shipped, the story is
  "Auto is the default, YOLO is explicit opt-in".

### Contributor context
- @qqshDA: issues only (#1706 closed, #1707 open), no code merged;
  credited in Aug 25 in-app release notes. Do not say we merged
  their code.
- @Scoteezy: merged #1562 (env sanitizer), #1463 (per-session
  encrypted sync), #1598 (Android HomeDock controls).
- @chphch: merged #1674 (effort schema), #1599 (mobile submit).
- @kevin1sMe: #995 closed not merged; fix applied in cf645f7f.
- @snvtac: PR #1447 closed unmerged, superseded by #1562.
- #145 contenders: #822 (@andrewschmidt-a, inactive draft) vs
  #1034 (@MauroDruwel, pure ACP); asked them to coordinate.

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
- #1716 — new-session prompt lands in latest session (fix likely in
  07732a97, awaiting reporter)

### P1 — important, workaround exists
- #1707 — project pinning + reorder within pinned (UX spec posted)
- #1631 — OpenCode first-class in app picker/spawn
- #145 — copilot CLI (two open PRs, asked authors to coordinate)

### Stale entries from April session
The April P0/P1/P2 lists predate CLI 1.2.1 and the v1.7+ apps; most
are fixed or obsolete. Re-verify before acting on any of: #613,
#682, #528, #106, #837, #685, #102, #652, #966, #165, #36, #156,
#248, #358, #25, #505, #719.

## Notes
- npm `happy` package donated by @franciscop (issue #880)
- ACP agent detection is hardcoded per-agent (6-7 touch points)
- Production app == Expo OTA buildCommitSha; verify via u.expo.dev
  with expo-channel-name=production before claiming "shipped"
