# Triage Checkpoint

Last session: 2026-08-27 (CLI 1.2.2 released: Windows daemon
subprocess fix, auto permission mode is now the default - story is
"Auto is the default, YOLO is explicit opt-in"; old CLIs degrade to
`default`, user overrides untouched). Full triage: 2026-08-25.

## Pending follow-ups
- #1716: waiting on reporter after 07732a97; root cause only
  partially explained (auto-mode drop explains a vanished prompt,
  not one routed to the latest session). If they confirm, close;
  if not, reproduce with their platform/version answers.
- #1695, #1679: close once reporters confirm.
- #1450: per-project defaults intentionally not built; reporter was
  asked to file a separate issue if wanted.
- #1707: waiting on contributor screen recordings (two variants)
  before any pinning implementation review.
- #1725 / #1729: close once Windows reporters confirm 1.2.2 fixed
  the flashing CMD windows.

## Contributor context
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

## Standing product guidance

- Product split: happy-agent is the primary harness, happy-desktop
  is the primary UI, and this repo is the mobile app (happy-mobile
  for now).
- Core for the app: keep supporting direct codex / claude / other
  harness spawning, and work FLAWLESSLY with happy-agent.
- The underlying backend/APIs are expected to change, but the UX
  can be polished now. Goals: UX + performance + bug-free.
- Web is deprioritized: point people to happy-desktop.

## Themes (priority order)

1. **table stakes** — devs use it daily and don't want to kill
   themselves. critical bugs, UX blockers, polish.
2. **growth** — viral features, community, social, engagement.
   anything that makes happy spread. may spin off per-feature
   themes later.
3. **devx** — how hard is it to build a new feature? env setup,
   e2e testing, docs/skills hygiene, reducing friction for
   contributors. increases throughput on everything above.
4. **reliability** — sync, error reporting, alerting, resilience.
5. **orchestration** — cross-machine sync, session spawning/forking,
   resume, handoff between devices.
6. **agent-integrations** — new agent CLIs (copilot, cursor, etc),
   SDK updates, making agents spawnable from mobile/web.

Not themes (tracked, not focus areas):
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

## Notes
- npm `happy` package donated by @franciscop (issue #880)
- ACP agent detection is hardcoded per-agent (6-7 touch points)
- Production app == Expo OTA buildCommitSha; verify via u.expo.dev
  with expo-channel-name=production before claiming "shipped"
