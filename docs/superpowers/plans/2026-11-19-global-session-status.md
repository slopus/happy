# Global Session Status Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, followed by one independent whole-branch review.

**Goal:** Implement the approved global/session/project visibility in the real desktop project workspace.
**Architecture:** A Web-only monitor provider derives one snapshot from the existing account store and socket state; pure categorization and scoped ownership feed the entry, summary and task button. The drawer opens existing sessions without synthetic actions or polling.
**Tech Stack:** React, RN Web, Unistyles, Expo Router, Zustand, Vitest.
**Spec:** docs/superpowers/specs/2026-11-19-global-session-status-design.md

## Global Constraints
- Root stays clean main; implementation in sibling worktree.
- Use semantic theme tokens and existing session state; no production demonstration data.
- No new state polling, server endpoints, Android native changes or Tauri work.
- Existing GitHub CI is the only production publishing path.

## Review Focus
- Socket or worker disconnection must not advertise stale running sessions.
- Explicit metadata overrides cwd; machine and path boundaries prevent cross-project leakage.
- Auto-archived unread application results stay accessible; explicit archive/deletion does not leak.
- Account/scope changes and close/Escape must not leave stale drawer data or keyboard handling.
- Navigation uses exact real session IDs and does not acknowledge failures or unread before opening.

### Task 1: Activity model
Files: sources/components/sessionActivity/sessionActivity.ts + .test.ts under packages/happy-app.
Interface: buildSessionActivity(sessions, unread, connected) yields mutually exclusive category rows; matchesActivityScope(row, scope), countSessionActivity(rows).
- [x] Write and run failing tests for canonical state priority, offline/socket unknown, archive/unread/duplicates and machine/path/task ownership.
- [x] Implement pure model and pass targeted tests alongside canonical session state tests.

### Task 2: Desktop monitor integration
Files: ProjectSessionMonitor.web.tsx, ProjectSessionMonitor.tsx, shared types, component tests; ProjectGoalsWorkspace.tsx integration.
Interface: ProjectSessionMonitor(scope, children), GlobalSessionEntry, ProjectSessionSummary, ProjectTaskSessions(task, machineId, featurePath, onFallback).
- [x] Write and run failing component tests for open/scope/status/search, resume updates, real navigation and close handling.
- [x] Implement provider/drawer and insert entry, subtitle summary and card button using current theme primitives.
- [ ] Verify targeted component suites, app typecheck and build. Document Web-only native fallback and conservative OTA impact.

### Task 3: Review and release
- [ ] Independent branch review; address material findings with regressions.
- [ ] Commit/push/PR under standing Paws delivery authorization; validate current-head CI before ordinary head-bound merge.
- [ ] Verify merge Web/OTA workflows separately and record limitations. Browser verification uses Ego only; no unsolicited screenshot matrix.

## Execution ledger

Task 1: complete — RED missing module then GREEN; activity + canonical state 25/25.
Task 2: model/component + project/history regression 202/202 and app typecheck passed. Full isolated App mounted, cross-project running2/current1 verified; actual completion updated unread1 through encrypted server events. Offline fallback regression observed RED→GREEN. No production data used.
Ruling: Native default exports preserve the existing action and render no monitor; shared integration conservatively triggers existing OTA workflow — no native/runtime changes.

Final review: independent read-only reviewer found four P2 issues and one fixture coverage gap.
Final: fixed stale task border — transport-loss border test RED→GREEN; existing history association remains intact.
Final: fixed stale reconnect/cold-cache trust — storage transport presence tests RED→GREEN; disconnect/connecting invalidates online presence, reconnect alone does not restore it, fresh authoritative header does. Durable outcomes remain unchanged.
Final: fixed authoritative project path/catalogue-title search — bound project-a + Design Library search test RED→GREEN; uses already-loaded catalogue, no per-session requests.
Final: fixed closed-drawer durable tombstone scan — 200 idle headers test RED→GREEN, only three activity candidates read tombstones. Closed lists skip scope/search processing.
Final: corrected auto-archive fixture to valid appId/bindingId and asserted real archive precondition.
Final: all related model/component/history/store regression 226/226 passed. Fix-pass typecheck caught a widened test enum; fixture narrowed before final verification. No deferred material findings.
