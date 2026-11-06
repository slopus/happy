# Goal First Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans; user explicitly authorized immediate execution, so no further design approval is needed. Preserve this plan and evidence through completion.

**Goal:** Integrate the approved task board with real Goal First records, original artifacts, task sessions, and measured performance checks.
**Architecture:** Typed shared wire contract; a session-scoped CLI controller reads authorized Goal First files and publishes changed snapshots through existing encrypted metadata. A memoized React Native panel uses existing file/media/session primitives. No new server, tunnel, polling, or summarization artifacts.
**Tech Stack:** TypeScript, Zod, Node fs.watch, React Native/Expo/Unistyles, existing encrypted session RPC, Vitest, Ego browser.
**Spec:** `docs/superpowers/specs/2026-11-06-goal-task-board-design.md`

## Global Constraints

- Work only in sibling worktree `happy--goal-task-board`, branch `feat/goal-task-board`; root stays clean main aligned to origin/main.
- Follow native five task statuses; invalid/absent status is `unknown`, never automatically completed.
- User-facing strings use t(); colors use theme semantic tokens; all supported translations updated by translator agent.
- No Tauri, blend, unapproved publication/merge, production daemon replacement, file tunnel, full-disk scan, or business polling.
- CLI parser uses realpath containment, bounded reads and actual links; no arbitrary media/path RPC access.
- Tests must demonstrate real failures before fixes for the new behavioral contracts. UI/browser testing only via Ego per AGENTS.
- Screenshot/recording preference has been asked asynchronously per CLAUDE; continue nonvisual checks without a response.

## Review Focus

1. Symlinks and Markdown links escaping the authorized Goal root must be rejected; parse limit and malformed frontmatter must not silently fake success.
2. Late requests after switching session/feature must not replace new state; watcher handles must close on session disposal.
3. Shared/legacy input materials must not count as current task's produced deliverables; catalog and actual status sources remain distinct.
4. Unicode/space filenames and large/binary files must open through correct lanes without unbounded base64 work.
5. Repeated task-session clicks and failed initial sends must not create duplicate sessions or lose navigation/drafts.

## Shared interfaces (Task 1 creates these in happy-wire/src/goalBoard.ts)

- `GoalTaskStatus`: pending | running | review | done | blocked | unknown.
- `GoalArtifactKind`: text | image | audio | video | pdf | commit | url | unsupported.
- `GoalArtifact`: `{ id, kind, name, path?:string, url?:string, description?:string, relation:'output'|'reference', size?:number, modifiedAt?:number, available:boolean }`.
- `GoalTask`: `{ id, code?:string, title, indexPath, promptPath?:string, status:GoalTaskStatus, goal:string, problem?:string, stage?:string, progress?:string, nextStep?:string, dependencies:string[], expectedDeliverables:string[], artifacts:GoalArtifact[], batch?:string }`.
- `GoalBoardSnapshot`: `{ featurePath, title, projectTitle?:string, revision, updatedAt:number, tasks:GoalTask[], warnings:string[] }`.
- `GoalBoardCatalogEntry`: `{ featurePath,title,projectTitle?:string }`.
- `GoalBoardBinding`: `{ featurePath, taskId?:string, parentSessionId?:string }`.
- Export Zod schemas for each of the above under their PascalCase name plus `Schema`.
- RPC `goalBoardCatalog` `{}` -> `{success:true,goals:GoalBoardCatalogEntry[]}` or `{success:false,error:string}`.
- RPC `goalBoardRead` `{featurePath:string}` -> `{success:true,snapshot:GoalBoardSnapshot}` or error; installs/replaces an event watcher for that feature; no periodic reads.
- RPC `goalBoardArtifact` `{featurePath,taskId,artifactId}` -> `{success:true,kind:'text',content:string,revision:string,name:string}` OR `{success:true,kind:'attachment',attachment:{ref,name,size,mimeType,kind:'image'|'audio'|'video'|'file',encrypted:boolean}}` OR error. Text max 2MiB; validate using registered artifact identity, never caller-supplied arbitrary path.
- CLI `registerGoalBoardHandlers(manager,workingDirectory,{onSnapshot,prepareAttachment,homeDirectory?})` returns `{dispose():void}`. onSnapshot publishes `metadata.goalBoardSnapshot`. No polling/timers; same revision skips publishing.
- CLI attachment preparation uses existing session upload methods for image/audio/video; PDF uses encrypted attachment upload. Preparing a preview does not post chat messages.
- App metadata adds `goalBoard?:GoalBoardBinding` and `goalBoardSnapshot?:GoalBoardSnapshot`.

### Task 1: Shared contract + CLI data/event/artifact controller

**Ownership:** happy-wire/src/goalBoard* and index export; happy-cli/src/modules/goalBoard/**, api/apiSession.ts, api/types.ts. Avoid other files.
**Consumes:** local Goal First project/feature/task index/PROMPT/problem documents; existing RPC and attachment APIs.
**Produces:** exact schemas/RPC above, ready for UI integration.

- [ ] Write and run failing real-filesystem tests: two projects, G01–G20 mapping to sibling features, dedup, canonical/unknown statuses, goal/problem/expected extraction, real output vs references, missing file, Unicode paths, symlink escape, size bounds, fs.watch change/disposal and no unchanged metadata.
- [ ] Implement contract and bounded parser/catalog. Locate installed skills from standard home skill entries and working-directory ancestors; no username hardcoding or recursive disk scan. Frontmatter/explicit field and heading parsing only; missing semantic fields remain absent.
- [ ] Register lifecycle-owned RPC and watcher callback from ApiSessionClient, persist encrypted snapshots, prepare artifacts on demand through existing attachments. PDF encryption and file stat limits must precede read/upload.
- [ ] Run related CLI/wire tests and CLI typecheck; report files and evidence. Do not alter production daemon or publish.

### Task 2: Memoized presentational task board

**Ownership:** happy-app/sources/components/goalBoard/** only (including tests).
**Consumes:** `GoalBoardPanelProps` below, plus shared wire types.
**Produces:** `GoalBoardPanel` and `GoalBoardTrigger`; no network ownership and no hardcoded fixtures in production.

Props: `{ snapshot:GoalBoardSnapshot|null, catalog:GoalBoardCatalogEntry[], loading:boolean, error:string|null, offline:boolean, activeTaskId?:string, onSelectFeature:(entry:GoalBoardCatalogEntry)=>void, onRefresh:()=>void, onClose:()=>void, onOpenArtifact:(task:GoalTask,artifact:GoalArtifact)=>void, onOpenTask:(task:GoalTask,newSession:boolean)=>Promise<void>, getTaskSessionId:(task:GoalTask)=>string|null, openingTaskId?:string|null }`.
Trigger props `{completed:number,total:number,open:boolean,onPress:()=>void}`.

- [ ] Write failing component tests for actual counters, search/filter, detail order, current vs expected artifacts, empty/offline/error, callback identities and duplicate click disable.
- [ ] Implement theme-aware and localized UI matching approved V3. Side panel is width <=380px, ScrollView with fixed actions; parent controls outer placement. Detail back resets scroll; task/artifact names can wrap; no wall-clock timers or per-keystroke RPC.
- [ ] Use `t('goalBoard.*')`; provide required keys and English/Chinese wording list to translator. Do not edit translations/SessionView directly.
- [ ] Run component tests; report remaining integration needs.

### Task 3: Original artifact viewer + file read performance

**Ownership:** happy-app/sources/components/GoalArtifactViewer.tsx (+test), sync/goalBoardArtifacts.ts (+test), FileViewPanel.tsx (+test), utils/filePathEncoding.ts (+test) and Unicode filename route callers if needed.
**Consumes:** goalBoardArtifact RPC contract + existing media FileView/Markdown/ImageViewer/openDocumentAttachment.
**Produces:** `GoalArtifactViewer({sessionId,featurePath,task,artifact,onClose})` with shared wire task/artifact.

- [ ] Write failing tests proving full Markdown and code rendering, no fetch until open, payload validation, request/session cancellation, size errors, image/audio/video/PDF dispatch and safe cleanup; Unicode paths round-trip.
- [ ] Use RPC only on explicit artifact open, cache by session/feature/artifact revision, reuse existing attachment renderer, and cancel/ignore obsolete responses. No summary. No new tunnel. Errors are explicit.
- [ ] Remove FileViewPanel's 5s whole-file polling, add user-triggered refresh preserving dirty edits/conflict protection; do not alter read/write authorization or silently overwrite.
- [ ] Implement UTF-8 file path encoding helper and update file route callers safely; code schema and error boundaries remain strict.
- [ ] Run targeted tests and report required translation keys; no publishing or production writes.

### Task 4: App integration, task-session lifecycle, translation and acceptance

**Ownership:** coordinator integrates sync/goalBoard.ts, hooks/useGoalBoard.ts, SessionView.tsx, Metadata schema, session ops and test harness; translator owns translation additions.

- [ ] Write failing integration tests for metadata schema, initial explicit binding, cached/offline state, revision events, stale requests, no refetch on open/close, and spawned task session idempotence/config inheritance.
- [ ] Implement real RPC hook, persisted binding, metadata snapshots, header trigger/side panel. Existing independent session primitive provides child task context and return lineage; only user action sends initial task.
- [ ] Add translations in every supported locale via the required translator agent.
- [ ] Run wire/CLI/App targeted suites, both typechecks, runtime contract, export/build and independent review; fix verified findings.
- [ ] Use isolated local runtime and real CLI filesystem fixture to verify C1–C7 via Ego. Measure cold/warm board open, artifact load, interaction long tasks and absence of idle RPC polling; separate local fixture from production evidence.
- [ ] Honor screenshot/video answer; if requested capture/report only authorized Ego frames, and send recorded MP4. No unauthorized browser tools.
- [ ] Persist acceptance/limitations and source/evidence in existing Goal First archive; prepare reviewable branch/PR and preview OTA only through applicable project release rules. No merge/production release inferred.
