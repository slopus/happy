# AgentParty approved workbench implementation

## Goal / spec
Implement the approved bright compact interactive design in the real `packages/paws-agent-party` application. Spec reference: sibling `happy--agentparty-interactive-draft/docs/prototypes/agentparty-group-chat.html` and accompanying Markdown at commit dc641612. Preserve actual Paws SDK execution, streaming, N-person debate and incremental context delivery from dependency 9ac2d906 (cherry-picked as e7ab9f11).

## Architecture and global constraints
React/Vite frontend, existing authenticated Node server, durable ProfileService/GroupRoomService, Paws SDK. No fake production replies or machine/model catalogs. Root main stays clean. Work only in this worktree. No automatic merge/deploy. No avatar uploads: use 24 locally bundled robot presets; message images remain supported. Preserve session provenance and remote sessions when a room is removed. No arbitrary directory authorization. Existing groups preserve execution configuration snapshots. At most 10 debate rounds, everyone speaks once per round. New UI uses semantic CSS theme variables and reduced motion support. No Tauri.

### Task 1: Durable agent configuration and room lifecycle
Files owned: src/group-chat/{profiles,rooms,codex-profile}.ts, src/server/{http,sdk,party}.ts, src/contracts.ts, associated backend tests under packages/paws-agent-party.

1. Add tests before code for profile avatarId (integer 0..23), optional paired machineId/directory (legacy profiles remain usable), snapshot configuration, per-member spawn machine/directory, invitation and room deletion.
2. AgentProfile input/output adds avatarId, machineId, directory. RoomAgentSnapshot keeps those and `temporary?: boolean`. Existing room machineId/directory remain fallback for legacy presets. Validate absolute authorized-on-spawn directory as existing semantics. No silent grants.
3. POST `/api/group-chat/rooms/:id/members` accepts `{requestId, memberIds?:string[], temporary?: AgentProfileInput[]}`. Validate names unique in room; duplicates by profile ID no-op, bad names rejected atomically. Temporary agents never persist to library. Join PartyBus participants, serialize admission, preserve debate participant list for active debate; newcomers eligible next prompt. Retried requestId idempotent.
4. DELETE `/api/group-chat/rooms/:id` removes local room and associated party via existing owner API, prevents later completion resurrecting it; reject active work with clear error requiring stop first. Never delete remote Paws sessions. Remove persisted lookup indexes so restart/retry cannot resurrect deleted room. Verify actual vendor Party delete support first.
5. SDK-powered configuration discovery: GET `/api/paws/machines/:id/directories?path=...` delegates machines.browseDirectory; GET `/api/paws/machines/:id/configuration` delegates existing SDK model discovery if available. Inspect actual SDK types: do not invent catalog. If SDK only session config exists, expose verified available capability path or explicit unavailable response, document limits. No credential exposure.
6. Run all backend tests/typecheck; report interface shapes and remaining gaps. Do not edit web files. Commit only owned files. No subagents.

### Task 2: Real compact workbench
Files: src/web/GroupChatApp.tsx, group-workbench.css, new extracted components/helpers and UI tests. Implement sidebar 240→72px, compact header, default-closed member popup, preset avatars, empty state, keyboard inline @, images, original-session execution details. Keep public timeline fed by real encrypted messages and streaming snapshots; room-keyed composer prevents async cross-room loss. Invite/delete call Task 1 endpoints. Configuration UI selects real machine labels and capabilities, reusable/temporary presets, no avatar upload. Deletion confirmation explains local removal vs remote sessions. 200ms transitions and reduced-motion. Test significant behaviors before implementation.

### Task 3: Verification and delivery
Run package tests/typecheck/build; independently review backend and complete diff, fix findings. Ego browser verification against controlled SDK fixture distinguishes UI verification from real remote execution. Fresh real execution only when credentials and available configured machine allow it; never claim fixture is a real Agent. No automatic merge or external deployment. Record acceptance cases and actual evidence below.

## Acceptance cases
| Case | Expected | Status |
|---|---|---|
| Layout | fixed viewport; sidebar collapse; members overlay; reduced motion | DOM + component checks passed; reduced-motion CSS reviewed; no pixel comparison |
| Identity | 24 robot presets; no avatar upload; consistent displayed avatar | fixture browser + regression tests passed |
| Config | readable machine; model/effort selection; execution snapshot | fixture browser + tests passed; bare-machine catalog unavailable, labeled candidates |
| Invite | library + temporary; no unintended preset persistence | backend tests + temporary invitation browser check passed |
| Compose | keyboard multi-@; image + text; room-safe draft | fixture browser + tests passed |
| Delete | confirm/cancel; last-room empty; active safety; durable removal | regression tests + fixture deletion browser check passed |
| Execution | streamed public text + details; N-member debate; incremental history | fixture + automated tests passed; fresh real remote execution not performed |

Final evidence: `packages/paws-agent-party/docs/workbench-acceptance.md`. Code ffb882dc passed independent review, 153 tests, typecheck and production build. No merge or deployment performed.
