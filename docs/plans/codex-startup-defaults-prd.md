# PRD: Codex CLI Startup Defaults and Dynamic Session Controls

Status: Local draft, not published upstream.
Date: 2026-05-04

## Problem Statement

Happy's Codex integration does not reliably honor the controls a user expects when starting or continuing a Codex session. A user can start `happy codex`, but cannot seed the session with Codex-native startup choices such as model, reasoning effort, or full yolo behavior. The mobile app already has model and permission controls, but routine app metadata can reset CLI-started defaults because the app always sends `permissionMode: default` and `model: null` when its selectors are on default. As a result, a user who starts Codex from the terminal with intended defaults can accidentally lose those defaults on the first mobile message.

This is especially painful for remote use. The user wants to start Codex once with the right safety/model defaults, then move between terminal, mobile, and web without remembering to set controls before the first message.

## Solution

Add a narrow Codex CLI startup-default layer for `happy codex` that seeds model, reasoning effort, and permission mode before the first turn. Map Happy's Codex `yolo` mode to Codex's native `--dangerously-bypass-approvals-and-sandbox` semantics: no approvals and no sandbox. Keep model and permission changes from mobile/web working between turns, but do not let routine app defaults erase explicit CLI-started defaults.

From the user's perspective:

- `happy codex --model gpt-5.5 --effort medium --yolo` starts Codex with those defaults.
- Mobile/web can still change model and permission mode during the session by selecting non-default values.
- A stale or default mobile app does not accidentally downgrade a CLI-started model or yolo mode by sending `model: null` or `permissionMode: default`.

## User Stories

1. As a Codex user, I want to start `happy codex --model gpt-5.5`, so that the first Codex turn uses my intended model.
2. As a Codex user, I want to start `happy codex --effort medium`, so that every Codex turn uses my intended reasoning effort until effort overrides are supported remotely.
3. As a Codex user, I want to start `happy codex --yolo`, so that Codex runs without approvals or sandboxing when I explicitly choose that risk.
4. As a Codex user, I want `--yolo` to mean the same safety posture as Codex's native dangerous bypass flag, so that Happy does not provide a weaker or surprising mode.
5. As a Codex user, I want `happy codex --permission-mode yolo` to behave the same as `happy codex --yolo`, so that scripts can use the explicit form.
6. As a Codex user, I want `happy codex --permission-mode read-only`, so that I can start a read-only remote session without touching the mobile selector.
7. As a Codex user, I want `happy codex --permission-mode safe-yolo`, so that Codex can work automatically inside the workspace while still retaining a safer boundary than full yolo.
8. As a Codex user, I want conflicting permission flags to fail clearly, so that I do not accidentally start a session with the wrong safety posture.
9. As a Codex user, I want the first mobile message not to reset my CLI-started `--model`, so that a stale app model list does not downgrade the session.
10. As a Codex user, I want the first mobile message not to reset my CLI-started `--yolo`, so that routine app defaults do not re-enable approvals.
11. As a mobile user, I want selecting a non-default model to change Codex's model for the next turn, so that I can switch models without restarting the session.
12. As a mobile user, I want selecting a non-default permission mode to change Codex's permission behavior for the next turn, so that I can tighten or loosen execution between turns.
13. As a mobile user, I want default/null app metadata to preserve explicit CLI defaults, so that ordinary message sends do not have hidden side effects.
14. As a terminal user, I want omitted startup flags to preserve current default behavior, so that `happy codex` remains familiar.
15. As a daemon-resume user, I want resume-provided model and permission mode arguments to be honored by Codex, so that resumed sessions keep the chosen controls.
16. As a contributor, I want this change to be CLI-only, so that the first upstream PR is focused and reviewable.
17. As a maintainer, I want the mode mapping covered by tests, so that future permission changes do not silently weaken yolo or break defaults.
18. As a maintainer, I want the argument parser covered by tests, so that startup flags remain predictable.
19. As a maintainer, I want source-aware default behavior covered by tests, so that routine app metadata cannot regress into overriding explicit CLI settings.

## Implementation Decisions

- Build a Codex-specific startup options parser instead of reusing Claude argument pass-through behavior.
- Support `--model <model>` and `--model=<model>` as Codex startup model defaults.
- Support `--effort <level>` and `--effort=<level>` for Codex reasoning effort. Valid values are Codex app-server values: `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Support `--permission-mode <mode>` and `--permission-mode=<mode>` for Codex permission defaults. Valid Codex modes are `default`, `read-only`, `safe-yolo`, and `yolo`.
- Support `--yolo` as sugar for `--permission-mode yolo`.
- Treat conflicting permission flags as an error instead of last-flag-wins.
- Keep `--resume` extraction behavior and thread it together with the new startup options.
- Extend the Codex run loop's enhanced mode state to include reasoning effort.
- Seed current model, permission mode, and effort from CLI startup options before reading the first queued message.
- Pass model, permission-derived execution policy, and effort into thread start when a new Codex thread is created.
- Pass model, permission-derived execution policy, and effort into every Codex turn.
- Change Codex yolo execution policy to the native dangerous bypass equivalent: approval policy `never` and sandbox `danger-full-access`.
- Keep `safe-yolo` as the softer automatic mode: workspace write with escalation behavior.
- Add source-aware state handling for model and permission mode:
  - CLI startup values are explicit startup defaults.
  - Non-default app message metadata overrides current state and becomes sticky.
  - Routine `permissionMode: default` does not clear an explicit CLI permission mode.
  - Routine `model: null` does not clear an explicit CLI model.
  - With no CLI startup value, routine app defaults preserve current default behavior.
- Do not add mobile app schema or UI changes in this PR.
- Do not add remote effort overrides in this PR because app message metadata does not currently carry effort.

## Testing Decisions

- Tests should verify external behavior through parser outputs, run-loop mode resolution helpers, and execution policy mapping rather than private implementation details.
- Add parser tests for:
  - model flag with separate and equals syntax
  - effort flag with separate and equals syntax
  - permission mode flag with separate and equals syntax
  - `--yolo`
  - `--resume` combined with model/effort/permission flags
  - invalid effort
  - invalid permission mode
  - conflicting permission flags
- Add command handler tests to verify parsed options are passed to the Codex runner.
- Add execution policy tests for the full Codex ladder:
  - `default`
  - `read-only`
  - `safe-yolo`
  - `yolo`
  - Happy-managed sandbox behavior
- Add tests for source-aware state resolution:
  - CLI model survives app `model: null`
  - CLI yolo survives app `permissionMode: default`
  - app non-default model overrides CLI model
  - app non-default permission mode overrides CLI permission mode
  - no CLI flags preserves default/null behavior
- Existing prior art includes the Codex CLI arg tests, Codex command handler tests, and execution policy tests in the CLI package.

## Out of Scope

- Mobile app UI changes.
- Shared message metadata schema changes for effort.
- Mobile/web effort propagation.
- Claude startup-default behavior changes.
- Native Codex TUI embedding.
- Terminal display or local input improvements.
- Server, encryption, or sync protocol changes.
- Large refactors of the Codex app-server client.

## Further Notes

The current Claude integration does not implement source-aware defaults either: routine app metadata can reset CLI-started Claude model and permission state. This PR should intentionally implement the intended behavior for Codex rather than copying that weakness. A later Claude parity PR can align Claude with the same source-aware default model.

The current app always includes permission and model metadata on sends. `permissionMode: default` and `model: null` are routine app defaults, not reliable evidence that the user explicitly reset controls. Without an explicit reset signal from the app, preserving CLI-started defaults is the safer behavior.
