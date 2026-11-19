# Dynamic Claude model catalogs implementation plan

> Execute inline with superpowers:executing-plans; obtain a fresh whole-branch review before integration.

**Goal:** Replace fixed Claude version labels with the selected runtime's native catalog.
**Architecture:** A bounded, prompt-free SDK control probe supplies encrypted machine RPC for new sessions and session metadata/RPC for running sessions. The existing picker refresh UI consumes the same normalized catalog; no timers query business state.
**Tech Stack:** TypeScript, Claude Agent SDK, Zod, React Native, Vitest.
**Spec:** `docs/superpowers/specs/2026-11-20-dynamic-claude-models-design.md` (approved).

## Constraints and review focus

- Preserve machine/agent/account boundaries, CLI configuration and active workers.
- Never send a synthetic user message, infer model versions, or expose account fields.
- Directory/model changes are data, including new effort strings; validate bounded responses.
- Failed/late refresh must not replace another machine's catalog or silently change a chosen model.
- Old runtimes retain unversioned aliases; no retry loop or background polling.

## Tasks

1. **Native catalog service** (`packages/happy-cli/src/claude/modelCatalog*.ts`, `api/apiMachine.ts`, shared wire schema): write failing tests for live catalog changes, aliases, malformed data and prompt-free timeout cleanup; implement parser/probe and deduplicated machine handler. Verify CLI unit tests/typecheck.
2. **Session integration** (`claudeRemote.ts`, `claudeRemoteLauncher.ts`, `runClaude.ts`, API/app metadata): publish initialization models and refresh from the same launch context, excluding restricted application catalogs. Test metadata forwarding and refresh failures without disturbing turns.
3. **Client integration** (`useClaudeModelCatalog.ts`, `SessionConfigPanel.tsx`, `SessionView.tsx`, `modelModeOptions.ts`): query on machine/agent/directory selection and menu refresh, fence stale results, consume per-model effort, remove fixed Claude versions. Write red tests for changing catalogs, unsupported/failed responses and machine races, then verify App regressions/typecheck.
4. **Review and delivery:** fresh branch review, relevant builds and CI, preview OTA; normal PR merge under existing standing grant, verify Web/production OTA separately. Preserve live execution patches for local activation; verify prompt-free encrypted directory RPC. Record device/model invocation limitations.

## Execution ledger

- 2026-11-20: Spec approved; inline execution chosen as routine implementation workflow, with one independent final review. No repeated implementation approval needed (confirmation-ops).
- Baseline: isolated sibling worktree, main `19fcb807`; dependencies installing with frozen lockfile.
