# Composer Agent Session Implementation Plan

Goal: Implement the approved Web composer Agent cycle and branded, reversible New session action.
Architecture: Web-only session hook stages a per-Agent model/effort selection, reuses useSpawnSession for real creation, and leaves source drafts/history intact. Shared composer accepts optional action metadata; native defaults preserve existing behavior. Existing model selector supplies the brand cycle.
Spec: approved design source happy--agent-switch-design/design/agent-send-brand-v4/REVIEW.md.

Constraints: Root clean main; sibling worktree; no production deployment before normal PR merge; no real user conversations used for test prompts. Existing Agent opt-in and live model discovery remain authoritative. Current Agent selection restores ordinary send/abort. UI state must not mutate source settings until normal send/model selection. Brand colors Claude #D97757 / Codex #3941FF / OpenCode #59616B.

Review focus: duplicate creation/retry, source/account/route changes during spawn, stale model catalogs or unavailable Agent, draft/context/attachment preservation, running task stop versus new empty session.

- [x] Add failing hook and action tests for staging, round trip, target models, empty spawn and failed retry; implement hook and Web action surface.
- [x] Integrate SessionView and MessageComposer without changing native defaults. Verify targeted tests, types and runtime contract.
- [x] Independent code review; resolve findings.
- [x] Real branch App against live execution service: Codex reply → Claude new session/reply → Codex new session/reply, plus return-to-current selection without spawn. Capture final flow and inspect brand/animation/overlay.
- [ ] Commit/push/create PR, validate exact-head checks, normal merge; verify main CI Web deployment and any OTA outcome.

Case table: C1 new Codex responds; C2 Agent cycle stages Claude and branded action creates/responds without changing source; C3 from Claude switch Codex, create/respond; C4 selecting source Agent again restores send and preserves draft. Baseline fffbb8875; browser recording and independent review evidence in docs/validation/composer-agent-session.md.
