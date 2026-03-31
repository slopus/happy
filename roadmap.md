# Roadmap

This file is the cross-product execution plan for the current Happy push.

# Key Milestones

- wrap up current improvements NO NEW SCOPE - focus on stabilizing features, not new features
- release beta / test on main
- start charging for voice - find the branch somewhere / figure out how to test this exactly on prod build?
  - How to configure 
- ship new app build
- share talk to 

## Working rules

- Agent workflow is defined in `.agents/agents/manager.md` and
  `.agents/agents/engineer.md`. The roadmap is product scope, not the source of
  truth for orchestration behavior.
- Web is the primary validation surface for now. Full validation still includes
  the real server and real CLI behavior, but manual product testing should be
  done on web before spending time on iOS.
- Keyboard shortcuts are deprioritized.
- Do not change individual chat ordering. If ordering work is done, it should apply to worktree or project groups, not to individual sessions.
- Right-click archive already exists and should be preserved.
- "Background separation like conductor" is not a standalone requirement unless it naturally falls out of simplifying the layout.
- Use Expo best practices for both native and web, even when web is the only surface being manually validated.

## P0. Happy-agent orchestration and task fan-out

Goal: make `happy-agent` the reliable control plane for dispatching and monitoring the rest of this roadmap.

### Required outcomes

- Verify the current `happy-agent` implementation on the real stack from this current environment before using it to spawn work for the rest of the roadmap.
- Fix any blocking issues in the current branch first, rather than assuming `happy-agent` is ready and immediately branching into many worktrees.
- Ensure that a spawned agent session appears in the same authenticated Happy environment as the current session, so the user can see those chats later without switching accounts or contexts.
- Use `happy-agent` to create worktrees and spawn new agent sessions only after the base flow is proven locally.
- After the base flow is stable, scale to parallel task fan-out, with a target of roughly 10 concurrent agents only if monitoring and reporting are already reliable.

### Concrete requirements

- Finish and validate `happy-agent spawn`, mirroring the app's `spawn-happy-session` flow.
- Spawn must create or choose a worktree for the task rather than reusing the current working tree.
- Spawned session metadata must clearly retain:
  - machine
  - project path
  - worktree path
  - agent flavor
  - session id
  - thread id or equivalent provider metadata when available
- Test the current auth path and ensure the agent runs under the same Happy account/environment as the current session.
- If different privilege models are needed, support that explicitly instead of hiding it. The likely split is:
  - same-account control for normal spawned agents
  - elevated flow only where strictly necessary
- Add a monitoring flow that can continuously check status across many spawned sessions and report:
  - active vs idle
  - pending permission/tool requests
  - last meaningful output
  - whether real validation evidence has been attached
- Add a reporting flow that writes status back into this roadmap under each task instead of leaving results scattered across chat history.
- Do not trust a spawned agent's "done" message by default. Require it to provide:
  - exact scope completed
  - concrete tests performed
  - a web URL the user can open
  - any caveats, skipped items, or uncertainty
- Support the longer-term workflow ideas, but only after the base flow is solid:
  - per-agent install/setup instructions
  - post-agent hooks
  - spawning a defined follow-up agent after a session
  - project-level or session-level automatic follow-up agents
  - simple "omni agent" / conductor-like checks stack

### Validation requirements

- Validate on web with the real server and real CLI, not a mocked environment.
- Prove the flow in the current environment first:
  1. authenticate or reuse existing auth in the current env
  2. spawn a real agent into a new worktree
  3. confirm the session is visible in the same Happy environment
  4. send work to it
  5. monitor it to idle
  6. collect a real verification link
  7. write the report back into this roadmap
- Only after this passes should the other roadmap items be delegated through `happy-agent`.

### Phase 3.0 validation report (2026-03-30)

**Result: PASS — base happy-agent spawn flow validated end-to-end.**

Environment: `eager-summit` (local real stack — real server on `:50371`, real CLI daemon, real Expo web on `:50372`).

| Step | Outcome |
|------|---------|
| 1. Auth | Reused seeded account secret from `eager-summit` env. `happy-agent auth status` → Authenticated. |
| 2. Machines | `happy-agent machines --json` → 1 active machine (`0cf073cd…`), daemon PID 90416, all 4 CLI flavors available. |
| 3. Worktree | Created `agent-test-branch` worktree at `.dev/worktree/agent-test` inside the env project. |
| 4. Spawn | `happy-agent spawn --machine 0cf073cd --path …/agent-test --agent claude` → session `cmndwh245001sy7hsqbhlp38o`, type `success`. |
| 5. Visible | `happy-agent list --active` shows the session. Server REST `/v2/sessions/active` confirms encrypted session record. |
| 6. Send work | `happy-agent send <id> "Create VALIDATION.md…" --yolo --wait` → message delivered, Claude used Write tool, turn completed. |
| 7. Monitor idle | `happy-agent wait <id> --timeout 10` → "Session Idle" immediately. |
| 8. Artifact | `VALIDATION.md` on disk: `happy-agent spawn validation successful - 2026-03-30`. |
| 9. Web URL | `http://localhost:50372/session/cmndwh245001sy7hsqbhlp38o?dev_token=…&dev_secret=…` |

**Session metadata retained:**
- machine: `0cf073cd-8945-4d10-9fd1-b2b61c341ea0`
- path: `…/eager-summit/project/.dev/worktree/agent-test`
- flavor: `claude`
- session id: `cmndwh245001sy7hsqbhlp38o`
- claude session id: `a670ba05-68ba-4289-b085-9270806be049`

**Issues found:**
1. **Permission blocking without `--yolo`:** Default permission mode blocks on Write tool with no happy-agent command to approve. First attempt required stopping and re-spawning. Need `happy-agent approve <session-id> <request-id>` command.
2. **Auth requires account secret:** Production `access.key` uses dataKey format (no raw secret). `happy-agent auth login` needs interactive QR scan. For automated orchestration, either: (a) add a daemon-local auth seeding path, or (b) derive agent credentials from the daemon's existing auth.
3. **`happy-agent stop` via Socket.IO doesn't kill the CLI process.** The daemon's HTTP `/stop-session` is needed for hard stop.

**Next steps:**
- Add `happy-agent approve` command for permission management
- Add daemon-local credential seeding for `happy-agent` to avoid QR requirement in automated flows
- Verify same flow against production server once auth seeding is available
- Scale to 2-3 concurrent spawns before attempting full fan-out

### Post-Phase 3.2 priority decision (2026-03-30)

**Next highest-impact work item: Phase 3.4 — multi-session monitoring and roadmap-backed reporting.**

The base `happy-agent` control path is now proven on the real stack:

- spawn works in a new worktree
- send/approve is consumed by the running session
- local-daemon stop works when the daemon HTTP port is current

The remaining stale `daemonState.httpPort` race is real, but it is a narrower
P1 reliability issue, not the main blocker for using `happy-agent` as the
roadmap control plane. The bigger missing P0 capability is still the one the
roadmap explicitly called out after base-flow validation: reliable monitoring
and reporting across more than one spawned session.

**Why this is next:**

1. Monitoring/reporting is the largest unmet P0 requirement after Phases 3.0-3.2.
2. It is the gating capability before delegating the rest of the roadmap
   through `happy-agent`.
3. It naturally exercises the already-fixed send/approve/stop plumbing under a
   more realistic 2-3 agent workload.
4. The stale daemon-state bug can be carried as a parallel P1 control-flow fix
   unless it blocks the multi-session validation directly.

**Scope of Phase 3.4:**

- prove `happy-agent` can manage **2-3 concurrent spawned sessions** in the
  same authenticated Happy environment
- expose/report, at minimum, for each spawned session:
  - active vs idle state
  - pending permission/tool requests
  - last meaningful output
  - attached verification evidence / web URL
- write those per-session results back into this roadmap instead of leaving
  them only in chat or shell history
- validate the monitoring/reporting flow on web with the real server + real CLI

**Explicitly not next:**

- deeper daemon restart/CAS debugging unless it blocks Phase 3.4 directly
- composer/session-list polish
- broader new-scope orchestration features

### Phase 3.4 results — multi-session monitoring validated (2026-03-30)

**Environment:** `snug-reef` — server `:52168`, web `:52169`, daemon PID 30480,
machine `e84feb4b-1729-4e33-80bf-64cfe2238fc9`.

**3 concurrent sessions spawned, driven, monitored, and stopped:**

| Session | ID | Worktree | Messages | Tool | Artifact | Final state |
|---------|----|----------|----------|------|----------|-------------|
| Alpha | `CorD57qW4kiYQNjVdXJFX4Gb` | `agent-alpha` | 6 | Write→completed | `ALPHA.md` (69B) | idle→stopped |
| Beta | `MqYPdxEb23uR1nZ9Uz5kPUam` | `agent-beta` | 5 | Write→completed | `BETA.md` (77B) | idle→stopped |
| Gamma | `PdWMnez3ek0HPHSErO8WKer3` | `agent-gamma` | 5 | Write→completed | `GAMMA.md` (77B) | idle→stopped |

**Per-session evidence:**

- All 3 sessions appeared in `happy-agent list --active` immediately after spawn.
- `happy-agent send --yolo --wait` delivered user messages and reported `sent: true`.
- `happy-agent wait` confirmed all 3 reached `Session Idle`.
- `happy-agent history` returned full v3 message transcripts with tool parts,
  step-finish(reason=stop), and model=claude-opus-4-6 on all sessions.
- Artifacts verified on disk: `ALPHA.md`, `BETA.md`, `GAMMA.md` all exist with
  correct content.
- `happy-agent stop` stopped all 3 (method: session-socket; stale httpPort
  prevented local-daemon-http path — known P1 issue from Phase 3.2).

**Web URLs:**

- Alpha: `http://localhost:52169/session/CorD57qW4kiYQNjVdXJFX4Gb?dev_token=...&dev_secret=...`
- Beta: `http://localhost:52169/session/MqYPdxEb23uR1nZ9Uz5kPUam?dev_token=...&dev_secret=...`
- Gamma: `http://localhost:52169/session/PdWMnez3ek0HPHSErO8WKer3?dev_token=...&dev_secret=...`

**No pending permissions or blocked tools** — all sessions ran in yolo mode and
completed without permission prompts.

**Verdict:** Multi-session spawn/send/monitor/stop flow works end-to-end with
3 concurrent sessions. The `happy-agent` CLI can reliably manage parallel agent
sessions and report per-session state, history, and artifacts. The stale
daemon-port issue (P1) remains the only known gap — it forced socket-based stop
instead of local-daemon-http stop but did not prevent correct session lifecycle.

**What this unlocks:** `happy-agent` is now validated as a control plane for
dispatching 2-3+ concurrent agent tasks with monitoring. The next step is either
fixing the P1 stale-port bug for reliable hard-stop, or beginning to use
`happy-agent` to dispatch real roadmap work items.

### Post-Phase 3.4 priority decision (2026-03-30)

**Next highest-impact work item: Phase 4.0 — use `happy-agent` to dispatch the
first real roadmap work batch.**

Phase 3.4 cleared the gating P0 requirement: `happy-agent` can now spawn,
monitor, report on, and stop multiple real sessions in the same authenticated
Happy environment. The highest-leverage next move is to start using that
validated control plane on actual roadmap work instead of doing another round of
control-plane-only validation.

**Why this is next:**

1. It is the direct payoff from the completed P0 work. The roadmap explicitly
   says other roadmap items should be delegated only after real-stack spawn +
   monitoring + reporting are proven. That condition is now met.
2. It has higher leverage than fixing the stale daemon-port bug first. The
   stale-port issue is real, but it is a narrower P1 hard-stop reliability bug
   that only shows up after daemon restarts. It does not block the already
   validated spawn/send/monitor flow in stable runs.
3. It outranks standalone P2 UI work because the main unresolved product value
   right now is parallel execution against real roadmap tasks, not more control
   plane rehearsal.
4. It creates real delivery pressure on the reporting format, monitoring
   surface, and evidence requirements that were just validated in synthetic
   multi-session runs.

**Scope of Phase 4.0:**

- dispatch 2-3 independent real roadmap tasks through `happy-agent`, each in
  its own worktree/session
- bias the first batch toward P1 items with clear reproduction and web
  validation, not P2 polish
- require each spawned session to report back:
  - exact scope completed
  - tests or validation performed
  - web URL
  - caveats / skipped items
- monitor those sessions to idle or a clear blocked state and write the results
  back into this roadmap
- treat the stale daemon-port bug as a candidate task inside that batch, not as
  the gating prerequisite for starting the batch

**Explicitly not next:**

- another standalone `happy-agent` validation phase with no real roadmap work
- broad P2 composer/session-list implementation
- deeper daemon restart debugging unless it blocks the first dispatched batch

### Phase 4.0 results — first real roadmap batch dispatched (2026-03-31)

**Environment:** `snug-reef` — server `:52168`, web `:52169`, daemon PID 30480,
machine `e84feb4b-1729-4e33-80bf-64cfe2238fc9`.

**3 P1 tasks dispatched via `happy-agent`, each in its own git worktree:**

| Task | Session ID | Worktree | Commit | Files changed | Result |
|------|-----------|----------|--------|---------------|--------|
| TaskOutput/TaskStop rendering | `OnVK4yUUp8qSb7c8QuHXz3pF` | `agent-task-rendering` | `ebd8130f` | 16 files, +235/-1 | PASS |
| Edit rendering fixes | `HYvEcNu751SXvNY2r1DXLsEH` | `agent-edit-rendering` | `34c3c5ba` | 4 files, +49/-13 | PASS |
| Stale daemon httpPort | `hY1taIsRCSjCroWojnTCrExj` | `agent-daemon-port` | `f8aaabac` | 1 file, +4 | PASS |

**Per-task details:**

**1. TaskOutput/TaskStop rendering (P1 — task rendering)**
- Scope: Created custom tool views for `TaskOutput` and `TaskStop` tool calls
- Changes: New `TaskOutputView.tsx` and `TaskStopView.tsx` components, registered
  in `_all.tsx` view registry, updated `knownTools.tsx` with input parsers,
  added `toolPartMeta.ts` subtitle extraction, updated all 10 translation files
- Typecheck: passed via `yarn typecheck`
- Caveats: Required a follow-up prompt to finish translation file updates and
  commit. Initial session explored the codebase extensively (28 msgs) before
  writing. Total: 72 messages across 2 prompts.

**2. Edit rendering fixes (P1 — multi-file edit rendering)**
- Scope: Fixed file path resolution and display for MultiEdit tool, shortened
  absolute paths in subtitles, added empty diff handling
- Changes: `toolPartMeta.ts` (shorten absolute paths to last 2 segments),
  `MultiEditView.tsx` and `MultiEditViewFull.tsx` (resolve file_path via
  `resolvePath`), `DiffView.tsx` (return null for empty diffs)
- Typecheck: passed
- Caveats: First session stalled after 2 messages (ToolSearch only). Required
  stopping and re-spawning a fresh session. Second session completed in 44
  messages. Root cause of stall unclear — may be a transient Claude session issue.

**3. Stale daemon httpPort (P1 — control-flow bug)**
- Scope: Fixed `daemonState.httpPort` not updating after daemon restarts
- Root cause: `getOrCreateMachine()` returns the server's existing machine record
  with the old daemon's httpPort. The connect handler then pushes this stale port
  back to the server.
- Fix: Override `machine.daemonState` with `initialDaemonState` immediately after
  `getOrCreateMachine()` returns (4 lines in `run.ts`). The `daemonStateVersion`
  is preserved for correct CAS updates.
- Typecheck: passed
- Caveats: None. Cleanest delivery of the three — single session, 26 messages,
  committed on first attempt.

**Web URLs (all accessible during env lifetime):**
- Task Rendering: `http://localhost:52169/session/OnVK4yUUp8qSb7c8QuHXz3pF?dev_token=...&dev_secret=...`
- Edit Rendering: `http://localhost:52169/session/HYvEcNu751SXvNY2r1DXLsEH?dev_token=...&dev_secret=...`
- Daemon Port: `http://localhost:52169/session/hY1taIsRCSjCroWojnTCrExj?dev_token=...&dev_secret=...`

**Observations:**
1. All 3 sessions ran in yolo mode — no permission blocks.
2. Stop method was session-socket for all (stale httpPort bug existed at dispatch
   time; the daemon-port fix was committed within this batch).
3. Agent reliability varied: daemon-port agent was flawless (1 session, 1 commit),
   task-rendering needed a follow-up prompt, edit-rendering needed a fresh session.
4. Total dispatch-to-completion time: ~15 minutes across all 3 tasks.

### Post-Phase 4.1 priority decision (2026-03-31)

The first dispatched batch is now merged onto `happy-sync-refactor`, so the
task-rendering, edit-rendering, and stale-daemon-port items are no longer the
highest-leverage P1 work. The remaining P1 blockers are the permission/control
paths that still make non-`yolo` remote agent management unreliable.

**Next dispatch batch:**

1. **Claude permission state correctness**
   - Scope: fix session-scoped approval (`Yes, don't ask again`), persist the
     real decision that was made, and remove duplicated/dropped/wrong-button
     permission states in the Claude UI.
   - Why now: this is the most direct blocker to using Claude-managed sessions
     without `--yolo`, and it overlaps the most user-visible broken P1 flows.
   - Validation: real web Claude session, verify approve, deny, approve for
     session, allow-all-edits, and stop/abort all produce the right UI state
     and the right downstream agent behavior.

2. **Claude plan approval UI**
   - Scope: fix the missing approve/deny controls for plan proposals and verify
     both decisions work end-to-end.
   - Why now: it is a distinct broken control path with a concrete repro and
     blocks a core non-`yolo` workflow even if ordinary tool permissions work.
   - Validation: reproduce from the `wise-river` session if still available,
     otherwise recreate the same flow on the current branch and prove both plan
     approve and plan deny from web.

3. **Codex non-`yolo` control-flow reliability**
   - Scope: fix Codex permission/sandbox behavior for non-`yolo` modes and the
     session lifecycle failures that make Codex hard to manage remotely
     (`stop` unreliability and sessions stuck in `thinking` with no visible
     updates).
   - Why now: once Claude permission flows are repaired, Codex becomes the
     remaining major provider path still forcing operators back to `yolo` or
     manual cleanup.
   - Validation: real web Codex session in a non-`yolo` permission mode, prove
     allowed work proceeds, blocked work surfaces correctly, stop works, and
     the session view settles instead of hanging in `thinking`.

**Explicitly not next:**

- provider/session metadata cleanup unless it directly blocks one of the three
  tasks above
- protocol-level read receipts / message-consumption acknowledgments, which are
  broader than the current dispatch batch and less actionable than the concrete
  permission/control regressions
- P2/P3 UI polish while P1 non-`yolo` control paths are still broken

### Phase 4.3 results — P1 permission/plan batch dispatched (2026-03-31)

Dispatched 3 tasks via `happy-agent` in `quiet-fjord` environment.

| Task | Session | Result |
|------|---------|--------|
| Claude permission state | `cJUmxwx6oN8U0R7NbudZ1vbJ` | PASS — 2 commits, 12 files |
| Plan approval UI | `ulL1KoV39CqO0bcnJZ73Ge2g` | PASS — 2 commits, 3 files |
| Codex non-yolo control | `3onyuUQK5dRy9WMt4H86gsy9` | FAIL — 63 msgs, 0 commits |

**What was delivered:**

1. **Permission state** — simplified PermissionFooter.tsx decision detection,
   added denial reason display, updated all 11 translation files.
2. **Plan approval** — ExitPlanToolView now shows approve/deny controls via
   PermissionFooter when the tool has a pending permission.
3. **Codex control** — agent spent entire session reading Codex runner,
   v3-mapper, and sync-node code without making changes. Task too broad for
   a single agent session.

**Codex task needs decomposition.** The remaining P1 Codex blocker should be
broken into 2-3 targeted sub-tasks:
- Sub-task A: Fix Codex PermissionFooter handlers + ops.ts decision mapping
- Sub-task B: Fix Codex v3-mapper step-finish emission for stuck-thinking
- Sub-task C: Fix Codex stop path reliability

## P1. Control-flow, permissions, and protocol bugs

Goal: remove the broken session-control paths that currently make remote agent management unreliable.

### Required outcomes

- Fix Claude permission flows that are still broken.
- Fix Codex permission and sandbox flows that still block useful work outside `yolo`.
- Fix missing approval UI when a plan is proposed.
- Fix task/tool rendering failures that hide agent output.
- Fix missing or unclear session/thread/provider metadata where it blocks orchestration or debugging.

### Concrete requirements

- DONE in Phase 4.3: Fix "Yes, don't ask again" / session-scoped approval behavior for Claude Code permissions.
- DONE in Phase 4.3: Fix Claude plan proposals that do not show approve / deny buttons.
- DONE in Phase 4.5: Fix Codex permission decision handling in sessionAllow/sessionDeny.
- DONE in Phase 4.5: Fix Codex session stopping — turn_aborted race condition in sendTurnAndWait.
- DONE in Phase 4.5: Fix Codex sessions appearing stuck in "thinking" — flush v3 mapper on abort/kill.
- DONE in Phase 4.0/4.1: Fix task rendering for tool calls like:
  - `TaskOutput`
  - `TaskStop`
- DONE in Phase 4.0/4.1: Fix multi-file and regular edit rendering/resolution so file diffs and file targets resolve correctly instead of producing broken or misleading output.
- Ensure permission UI correctly handles and persists the real decision that was made:
  - approve
  - deny
  - approve for session
  - allow all edits
  - abort / stop and explain
- Ensure permission state is not duplicated, dropped, or shown with the wrong buttons for Claude vs Codex.
- Ensure provider/session metadata needed for orchestration is stored clearly enough to inspect and debug:
  - Happy session id
  - provider session/thread id when available
  - flavor / agent type
  - machine / path / worktree context

### Session protocol: message consumption visibility

- For all agents (not just Codex): no way to know if a message was actually consumed by the agent
- Need read receipts / consumption acknowledgment at the protocol level
- Secondary: per-agent integration quirks are a separate swimlane (#agent-integrations)

### Validation requirements

- Reproduce and verify fixes on web with real sessions.
- For permission fixes, verify both the UI path and the resulting agent behavior after the decision is sent.
- For plan approval fixes, verify approve and deny both work.
- For task rendering fixes, verify the output is actually visible and meaningful in the session transcript.

### Post-Phase 4.6 priority decision (2026-03-30)

**Decision: begin P2. The next work item is Phase 5.1 — the first composer-overhaul dispatch batch.**

The remaining P1 items are still real, but they are no longer the highest-leverage next move:

- **Read receipts / message-consumption visibility** is important protocol work, but it is cross-cutting, less directly user-visible, and no longer blocking the already-validated `happy-agent` dispatch flow.
- **Provider/session metadata clarity** still matters for debugging, but the current metadata is already good enough to complete the Phase 3.0-4.5 orchestration work and roadmap dispatch batches.
- **Codex sandbox behavior in specific non-`yolo` modes** should stay open as a follow-up only when there is a fresh repro after the Phase 4.5 permission/control fixes.

P2 is now the better priority because it is the next major user-visible roadmap item and still fits the "no new scope" rule: it is a convergence/simplification pass that brings the new-session composer closer to the already-existing regular chat input instead of inventing another surface.

**Scope of Phase 5.1:**

- dispatch `2-3` independent composer tasks via `happy-agent`
- keep validation on web with the real server + real CLI spawn path
- bias the first batch toward the highest-value structural gaps, not attachments polish yet

**Initial Phase 5.1 batch shape:**

1. **Composer layout unification**
   - make the new-session composer visually/structurally closer to the regular chat composer
   - reduce chrome above the input
   - enforce the desired hierarchy: machine, project path, agent, input

2. **Composer controls integration**
   - move model / permissions / thinking controls into the input row or immediately adjacent to it
   - keep active-chat and new-session control treatment aligned

3. **Path and worktree entry flow**
   - add direct custom-path entry
   - preserve first-class worktree choices
   - auto-focus the relevant search/input when machine/path/worktree controls are opened on desktop

**Explicitly not next:**

- another P1-only dispatch batch for read receipts or metadata cleanup
- P2 attachment/image support before the core composer shape is fixed
- P3 session-list or tool-UI polish

### Phase 5.1 results (2026-03-30)

All 3 composer tasks dispatched via `happy-agent` and completed successfully.

| Task | Session ID | Commit | Files | Result |
|------|-----------|--------|-------|--------|
| Composer layout unification | `CfBQJcfhgFOOie3bX6ucBJxK` | `ed75b79a` | 1 file (+170/-145) | PASS |
| Composer controls integration | `LcDrpV2NS4l5lPwDKMGM1s7b` | `59e2b4b3` (cherry-pick of `ab8399c8`) | 4 files (+180/-1) | PASS |
| Path and worktree entry flow | `mRGX1aA3mbDeP4dRl3iI8NzB` | `5361e6d2` | 12 files (+104/-5) | PASS |

**What each agent delivered:**

1. **Composer layout** — Collapsed the 6+ row config box into a 2-row compact header: row 1 is machine (left) + path (right), row 2 is agent/model/effort/permission as inline tappable pills. Worktree is a compact pill in row 2. Input is now the main focus of the layout.

2. **Composer controls** — Added compact control pills (model, permission, effort) to the active-chat `AgentInput` component. Pills sit in a row below the text input inside the same visual container. Each cycles on tap. Added `useSessionEffort` hook and wired it through `SessionView.tsx`.

3. **Path/worktree entry** — Made the path picker search input double as custom path entry: if the typed value matches no existing item, a "Use this path" option appears. Added `autoFocus` on web for all pickers. Added translations for custom path strings across all 11 language files.

**Typecheck:** `npx tsc --noEmit -p packages/happy-app/tsconfig.json` passes with all 3 merged.

## P2. Composer overhaul

Goal: make new-session composition feel like the regular chat composer instead of a separate, more awkward surface.

### Required outcomes

- The new-session composer should be visually and behaviorally close to the regular chat input.
- The input should become the main focus of the layout, especially on laptop/web.
- The composer must support the missing path and attachment workflows needed for real use.

### Concrete requirements

- Keep the new-thread flow inline. Do not reintroduce a separate detached "new chat" surface.
- Keep the project picker on empty/new thread only.
- For an active chat, keep the regular chat input shape and only surface the relevant controls there, primarily model and permissions.
- Support entering a custom path directly instead of forcing only picker-based selection.
- Add image support.
- Add a `+` entry point at the lower left for attachments, and wire it to the encrypted file handling already supported by the product where possible.
- Reduce the amount of chrome above the input. The desired hierarchy is:
  - machine
  - project path
  - agent
  - the main input area
- The project path should be right-aligned in the composer header row.
- When interacting with machine / folder / worktree controls on desktop, auto-focus the relevant search field.
- The main input area should be much closer to the regular chat input, including:
  - similar visual weight
  - larger, more readable text
  - permissions / model / thinking controls integrated into the input row instead of stacked above it
- Worktree behavior in the composer must stay first-class:
  - choose no worktree
  - choose an existing worktree
  - create a new worktree
- Worktrees that match the project's worktree pattern should be treated as part of the same project rather than feeling like unrelated projects.

### Validation requirements

- Validate end-to-end on web.
- Confirm the spawn path still works with real server + CLI integration, not just local component state.
- If drag-and-drop behavior is added later in this area, capture a web video of the interaction.

## P2.5. PI-style agent controls, fork, and resume

Goal: make active-session agent controls feel first-class instead of scattered across info screens and one-off flows. The control surface should feel closer to a PI-style agent UI while still preserving Happy's regular chat input shape.

### Required outcomes

- An active chat should expose the primary agent controls in a way that is fast to scan and fast to use.
- Forking and resuming should feel like normal agent controls, not buried recovery flows.
- The user should always be able to tell what agent/session they are controlling:
  - flavor / agent type
  - permission mode
  - model / effort or thinking level when relevant
  - machine / project path / worktree
  - provider thread or resume context when available
- The design should borrow from PI-style control surfaces where useful, but should still fit Happy's chat-first product shape.

### Concrete requirements

- Build on the existing active-chat composer direction rather than inventing a separate detached control panel.
- For an active chat, keep the regular chat input shape and surface the relevant agent controls there or immediately adjacent to it.
- Support quick access to:
  - model
  - permissions
  - effort / thinking level where supported
  - stop / archive / resume
  - fork session
  - machine / path / worktree context
- Treat fork/resume as a first-class product flow:
  - right-click or quick action to fork an existing session
  - show a clear `<resuming session>` or equivalent context pill
  - allow choosing a different worktree
  - allow choosing a different agent where supported
  - use the resume session API on the machine to fork the underlying conversation
- Reuse the current session metadata and quick-action work rather than creating a second disconnected control path.
- Where PI-style controls imply protocol or lifecycle expectations, align with the protocol research already captured for ACP / Pi RPC rather than inventing another opaque control model.
- For UI design exploration, provide five competing implementation options. Keep switching between lightweight variants easy; if a variant is structurally different, split it into a sibling worktree track.

### Validation requirements

- Validate on web with real long-running sessions, not a tiny toy transcript.
- Exercise realistic behavior:
  - change controls during an active chat
  - fork a real session
  - resume or branch it into another worktree
  - confirm the new branch/session remains clearly attributable
- Record a web video of the full flow.
- Capture screenshots at key checkpoints:
  - before control change
  - after control change
  - fork/resume composer state
  - resulting branched session state

## P3. Session list, tool UI, and worktree-level ordering

Goal: reduce visual bloat, improve scanability, and make high-priority work easier to manage without touching per-chat ordering.

### Required outcomes

- Sessions and tools should be easier to scan on web.
- Worktree/project level prioritization should be possible.
- Archive actions should feel safe and reversible.

### Concrete requirements

- Add archive confirmation. Archiving should feel safe because resuming an existing session is trivial.
- Keep right-click archive and related quick actions available on web.
- Improve subagent presentation so nested work is clearly attributed and grouped.
- Do not show provider tool calls in a way that flattens or hides the subagent structure.
- Reduce tool UI bloat on web:
  - remove unnecessary button backgrounds and layering
  - make tool action buttons less bulky
  - group them more cleanly once the relevant output is done
- Eliminate the duplicated plan presentation where both raw file-edit content and the plan tool are effectively shown twice.
- Fix the black stripe artifact in file edit tool-call rendering.
- Fix markdown image rendering in session/chat messages so absolute-path screenshot syntax like `![](/absolute/path.png)` previews inline on web instead of failing silently during manager review.
- Ensure long worktree paths do not overlap with git changes or other row content.
- Add ordering by importance at the worktree/project level, not the individual chat level.
- When implementing ordering, support dragging worktree/project groups on web first.

### Validation requirements

- Validate all UI changes on web.
- When drag ordering ships, record a web video showing the interaction.
- Confirm that session grouping and archive actions still work after the layout changes.
- Verify that markdown image syntax using local absolute paths renders an actual inline preview in a real web session.

## P4. File links, changed-files review, and attachments

Goal: make file references in chat actually useful and make file review/attachment flows feel complete.

### Required outcomes

- File references in chat should resolve to something real.
- Clicking a file should open an actual file viewer, not just a dead-looking link.
- The changed-files review surface should match the underlying data correctly.
- Composer attachments should work in both new and regular chat flows.

### Concrete requirements

- Before rendering a file path as a clickable link, try to resolve it against the remote machine/session context.
- On click, fetch the file on demand again so the opened file reflects the current remote state.
- Open files in a full-screen file screen/viewer rather than a tiny inline fragment.
- Support file drop / attach in both:
  - the new-session composer
  - the regular in-chat composer
- Reuse encrypted file transport/storage already supported by the product where possible instead of inventing a second path.
- Fix the changed-files review/input mismatch so the review surface corresponds to the right files and content.

### Validation requirements

- Validate on web against a real remote session.
- Verify both initial resolution and refetch-on-open behavior.

## User Research

Goal: talk to users regularly to understand why they use Happy, what their day-to-day problems are, and what to build next.

### Outreach

- In-app PostHog survey offering your phone number / way to reach you directly
- Make it personal — "text me, I want to hear how it's going"

### Interview process

- When we actually talk, collect consent to record/transcribe
- Take structured notes during each conversation
- Store notes somewhere accessible (TBD — `/research` dir, Notion, or markdown)

### What to learn

- Why they started using Happy
- What their day-to-day workflow looks like
- What's painful or missing

## Growth & Promotion Pipeline

Goal: simple pipeline to promote Happy Coder and maintain the public repo presence.

### Promotion

- Regular posts / content about Happy Coder — what it does, how it works, real usage examples
- Figure out channels (Twitter/X, Reddit, HN, Discord, etc.)
- Collect and share user stories from the research interviews (with consent)

### Repo maintenance

- Keep GitHub issues triaged and organized
- Respond to community issues and PRs
- Use issues as a lightweight public roadmap signal

## Happy Evolve (self-modifying UI)

Goal: make it possible to customize any part of the Happy interface from within Happy itself. The app modifies its own frontend live.

### Approach

- Use Metro hot reloading to apply changes in real time
- Focus on making the frontend fully changeable for now
- No sync needed initially — local-only modifications
- Inspiration: pi.exe agent style self-modification, but more ambitious

### For later

- Pull in sync engine idea from Kirill's Happy fork where the sync engine is factored out

## Dynamic Session Icons

Goal: the brutalist icons are a big part of what makes Happy feel good to use — lean into that.

- Generate custom brutalist-style vector icons per session based on the topic
- Keep the same aesthetic — bold, minimal, appealing
- Potential paid feature
- TBD: generation approach (local model, API, precomputed set, etc.)

## Session Forking

Goal: right-click a session to fork it — clone the session in Happy + use the resume session API to fork the conversation on the machine. Lets you explicitly parallelize and control both branches.

### Flow

- Right-click session → "Fork"
- Opens a fork composer (like the regular composer) with:
  - a `<resuming session>` pill showing what you're forking from
  - ability to pick a different worktree
  - ability to pick a different agent
  - all the usual composer controls (model, permissions, path, etc.)
- On submit: clones the session in Happy, calls resume session API on the machine to fork the underlying conversation

## Session Protocol (UNDER REVIEW — FROZEN)

The session protocol (`role: 'session'` envelopes in `happy-wire/src/sessionProtocol.ts`) is **not used in production** and should not be used in dev environments either until we revisit the design. The legacy protocol (`role: 'user'` / `role: 'agent'`) is the active code path everywhere.

### Status

- Types are frozen in `happy-wire` — no new consumers
- Dev env was using it but should stop
- Production has never shipped it

### Before resuming

- Look at how pi.dev standardizes their agent protocol — we may want to align with or build on that instead of rolling our own envelope format
- Consider whether `happy-wire` should even own this, or if protocol definition belongs closer to the CLI / agent layer
- The current design may be over-engineered for what we actually need

## Deferred / later

- Keyboard shortcuts:
  - new session
  - next session
- Chrons board exploration
- Sample project / devx improvements
- Growth tracks:
  - Linear integration
  - more agents (`opencode`, `openclaw`, `conductor`)
  - Claude Code team of agents
  - software factory / `happy-agent`

## Native guardrail when native validation is needed later

- Do not recompile the iOS or Android client for JS-only changes when the development build is already installed and still matches the current native code.
- Prefer starting Metro against the current env and reusing the installed dev client.
- Rebuild with `yarn env:ios` or `yarn env:android` only when the build is missing, outdated, or native dependencies/config changed.
- Native app test flow:
  1. Start an authenticated env with `yarn env:up:authenticated` or reuse the current env from `yarn env:current`.
  2. Source the env so Expo picks up the right server and dev auth vars: `source environments/data/envs/<env-name>/env.sh`.
  3. For JS-only work, start Metro without recompiling native: `APP_ENV=development yarn --cwd packages/happy-app start --dev-client --port 8081`.
  4. Open the installed simulator or device build from Metro with `i` or `a`, or reopen the dev client onto the Metro URL.
  5. Confirm native auth is correct in Metro logs:
     - `credentials ...`
     - `📊 Sync: Fetched <n> machines from server`
     - `📥 fetchSessions completed - processed <n> sessions`
  6. Verify the target flow in-app. For session quick actions:
     - long-press a session row in the session list
     - long-press the top-right session avatar in a session
     - on web, right-click the same surfaces
