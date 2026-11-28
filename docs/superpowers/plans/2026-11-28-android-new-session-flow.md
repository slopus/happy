# Android New Session Flow Implementation Plan

> **For agentic workers:** Execute tasks with focused ownership and independent final review. Follow superpowers:test-driven-development for behavior changes.

**Goal:** Fix the Android new-session failures confirmed in the user-approved audit and supply real native evidence.

**Architecture:** Preserve the existing composer and agent-cycle interaction. Give fixed actions their natural width and the model the remaining width; make native selectors independent of stale keyboard anchors. Discover Antigravity capabilities on selection/user action and retain explicit selections while unavailable.

**Tech Stack:** Expo / React Native 0.83, Unistyles, Zustand, ACP, Vitest, Android API36 emulator / ADB.

**Spec:** `docs/validation/android-new-session-audit-20261127.md`, approved by user on 2026-11-28 with instruction to repair.

## Global constraints

- Root remains clean main; implementation uses this sibling worktree, rebased onto `375cefbead32b8e494c37b86a5a1f8092c7cf98c`.
- No new permanent input-region content or toolbar. Preserve drafts, attachments, permissions, and established agent cycling.
- No polling, clearing user data, unrelated CLI activation, native/runtime changes, or Tauri work.
- Android component fixtures, complete App, backend execution, OTA artifacts and user's phone are separate evidence scopes.
- Shared UI is delivered as compatible preview OTA using existing CI; do not deploy a branch to production Web.

## Review focus

- Opening selectors during IME composition and dismissing them must preserve text and placement.
- Long model/permission names must not remove send, context, or permission actions at 320–430dp and enlarged text.
- Missing/error/empty capabilities must not silently overwrite an explicit model or effort or send a different model.
- Responses after machine/directory/Agent changes must not update another scope.
- Non-default dark themes must retain readable normal, pressed and selected controls.

### Task 1: Native composer geometry and selector lifecycle

**Files:** `MessageComposer.tsx`, `SessionComposerModeSelector.tsx`, `SessionComposerPermissionSelector.tsx`, `ComposeHome.tsx`, their focused tests, optional shared native-selector helper.

**Interfaces:** Existing selector configs, composer props and callbacks remain compatible. Model label owns remaining toolbar space; fixed actions remain reachable. Native panels honor keyboard/safe areas without stale opening coordinates.

- [x] Add regressions for IME/Modal opening lifecycle and draft-preserving close/reopen.
- [x] Observe failing tests and use existing native fixture as baseline.
- [x] Implement minimal layout and native selector changes; preserve Web paths and agent cycling.
- [x] Verify selector/composer tests and native widths, keyboard and Back interactions.

### Task 2: Antigravity discovery and explicit-selection protection

**Files:** `SessionConfigPanel.tsx`, `newSessionModeSelection.ts`, scoped catalog hook and sync ops; reuse or minimally extend CLI ACP catalog RPC and wire contracts where necessary; focused tests.

**Interfaces:** Capabilities are scoped to machine/directory/agent, read on user selection or refresh. Unknown/failed catalog preserves explicit draft; confirmed missing choice blocks submission. No periodic refresh or model inference by ID.

- [x] Regress first-use discovery, stale responses, failure, disappearance and explicit effort hydration.
- [x] Observe failing tests.
- [x] Reuse actual Antigravity catalog source and add a bounded read-only discovery path if absent.
- [x] Integrate loading/error/retry into the existing transient selector surface and validate send selection consistency.

### Task 3: Readability and integration

**Files:** Existing theme/semantic tokens only if needed; native fixture and `docs/validation/android-new-session-flow-fix.md`.

- [x] Use semantic readable text on controls, without changing unrelated secondary copy globally.
- [x] Validate palette contrast and non-default dark theme states; add a theme regression if mapping changes.
- [ ] Run targeted suites, App/affected CLI typechecks, runtime contract and required checks.
- [ ] Independent review, real native reproduction after fix and complete-App launch/create checks where environment supports them.
- [x] Restore fixture entries/Metro/reverse/display settings, archive and deliver native media.
- [ ] Push a reviewable PR/preview through existing workflow and record exact OTA metadata; do not claim user's phone passed without device evidence.
