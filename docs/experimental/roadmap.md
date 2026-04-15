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

## P1. Control-flow, permissions, and protocol bugs

Goal: remove the broken session-control paths that currently make remote agent management unreliable.

### Required outcomes

- Fix Claude permission flows that are still broken.
- Fix Codex permission and sandbox flows that still block useful work outside `yolo`.
- Fix missing approval UI when a plan is proposed.
- Fix task/tool rendering failures that hide agent output.
- Fix missing or unclear session/thread/provider metadata where it blocks orchestration or debugging.

### Concrete requirements

- Fix "Yes, don't ask again" / session-scoped approval behavior for Claude Code permissions.
- Fix Claude plan proposals that do not show approve / deny buttons.
  - Repro session:
    - worktree: `~/projects/happy/happy/.dev/worktree/wise-river`
    - Happy session id: `cmmbujpkq03iey7lcxyd9fqaw`
- Fix Codex sandbox behavior where work is still blocked in non-`yolo` modes when it should be allowed by the selected permission mode.
- Fix Codex session stopping — currently unreliable / painful.
- Fix Codex sessions appearing stuck in "thinking" indefinitely with no updates — may be a frontend rendering issue where updates aren't being pushed to the session view.
- Fix task rendering for tool calls like:
  - `TaskOutput`
  - `TaskStop`
- Fix multi-file and regular edit rendering/resolution so file diffs and file targets resolve correctly instead of producing broken or misleading output.
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
