# AgentParty Paws POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于真正 agents-party 源码实现图文股票多周期会诊 POC，执行走真实 Paws SDK，群聊与执行详情分离。

**Architecture:** 新独立包包含有 provenance 的上游消息总线与 React Chat fork。Node 常驻服务同时托管 Party API、Paws 会话适配及受认证附件；浏览器不拥有账号 secret，只有随机本地访问 token。固定会诊模板不是新通用编排引擎。

**Tech Stack:** Node 24、TypeScript、pnpm、agents-party 0.7.2 源码、Paws SDK workspace、React 19、Tailwind 4、esbuild/Vite、Vitest。

**Spec:** `docs/superpowers/specs/2026-09-16-agentparty-poc-design.md`

## Global Constraints

- Only modify `/Users/jacky/jacky-github/happy--agentparty-poc`; root clean main and other worktrees are read-only.
- Base is `1gr14/agents-party` commit `af00afbd49b3235c2084cff9849ef12353073484`, MIT. No LangGraph, OpenClaw installation, or replacement chat framework.
- Source is `/private/tmp/agents-party-audit.EYv32u/repo`; copy only the transitive source needed for client/local storage/server API and Chat UI. Preserve LICENSE and original file paths beneath vendor/agents-party; provenance records any modifications. Do not overwrite that original checkout.
- Package name `@wangjs-jacky/paws-agent-party`; package path `packages/paws-agent-party`. Update only its explicit workspace registration and lockfile outside it.
- Use pnpm. Do not symlink node_modules, restart daemon, alter CLI global install, push, merge, deploy, publish, or read credentials from other applications.
- Real Agent is production-only behavior. Test doubles live only under test/, visibly marked when exercised through a test server. Mock market is always labelled synthetic / not investment advice.
- Loopback-only HTTP; every API and attachment requires access token. Validate Host/Origin, no permissive CORS, bounded request/file sizes. Paws credentials default memory-only, normal QR authorization. Do not print secrets.
- Images: at most 4 PNG/JPEG/WebP files, at most 10 MiB each. Preserve text-only, image-only, and mixed submissions.
- A role maps to one Paws session per run. Supported engines for this POC: codex, claude, gemini, opencode, chosen per role.
- Roles: `moderator`, `trend30`, `structure10`, `timing1`. Single mode only moderator; consultation mode exactly eight initial turns. Different specialists run concurrently, same session is serialized.
- No automatic permission approval; show pending permissions and original session access. Stop cancels coordination/observation, never claims remote process termination.
- Restart marks interrupted runs and never automatically replays a potentially executed task. In-process requestId dedupe survives in persisted state. No exactly-once claims.
- UI retains upstream Chat/Composer/Sidebar and adapts original PartyApp flow. Clicking Agent opens details; separate recipient chips keep directed messaging. Receive cursor only advances from received batches; own sends cannot jump it.

## Shared interface contract

Create `src/contracts.ts` as the single shared boundary, exporting these shapes (types can add safe fields):

```ts
type RoleId = 'moderator' | 'trend30' | 'structure10' | 'timing1';
type Engine = 'codex' | 'claude' | 'gemini' | 'opencode';
type ImageRef = { id: string; name: string; mimeType: string; size: number };
type StartInput = { requestId: string; stock: string; text: string; images: ImageRef[];
  machineId: string; directory: string; agents: Record<RoleId, Engine>; mode: 'single' | 'consultation' };
type RoleSnapshot = { role: RoleId; status: string; sessionId?: string; error?: string };
type FollowUpStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
type FollowUpSnapshot = { requestId: string; to: RoleId[]; status: FollowUpStatus;
  roles: Partial<Record<RoleId, { status: FollowUpStatus; error?: string }>>;
  createdAt: number; error?: string };
type TurnProvenance = { runId: string; partyId: string; participant: RoleId;
  taskMessageId: string; publicMessageId?: string; localId?: string;
  sessionId?: string; rootTurnId?: string; sourceMessageId?: string };
type RunSnapshot = { id: string; partyId: string; stock: string; mode: 'single' | 'consultation';
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; phase: string;
  createdAt: number; roles: Record<RoleId, RoleSnapshot>; followUps: FollowUpSnapshot[];
  turns: TurnProvenance[]; error?: string };
type ConnectionStatus = { state: 'disconnected' | 'linking' | 'connecting' | 'ready' | 'error';
  serverUrl?: string; qrUrl?: string; error?: string };
```

HTTP contract (Bearer access token everywhere):

- `GET /api/paws/status` => ConnectionStatus; `POST /api/paws/link {serverUrl}` => ConnectionStatus; `DELETE /api/paws/link` => clears pending link and memory credentials, disallowed while run active unless first explicitly stopped.
- `GET /api/paws/machines` => `{machines: Machine[]}` using SDK shape; users explicitly choose directory and machine.
- `POST /api/assets` => raw bytes, `Content-Type`, `X-Filename` percent-encoded UTF-8; response ImageRef. `GET /api/assets/:id` => authorized image bytes.
- `POST /api/consultations` StartInput => RunSnapshot (starts asynchronously); `GET /api/consultations` => `{runs: RunSnapshot[]}`; `GET /api/consultations/:id` => RunSnapshot.
- `POST /api/consultations/:id/stop {}` => RunSnapshot, stop warning included in UI.
- `POST /api/consultations/:id/messages {requestId,text,to: RoleId[],images: ImageRef[]}` => `{accepted:true}`; only terminal runs accept follow-ups, blank to means moderator. Serialize follow-up on each role; reject while initial run executing.
- `GET /api/consultations/:id/agents/:role/messages?afterSeq=0` => `{sessionId?:string,messages:Message[],hasMore:boolean,requests:AgentRequest[],status:string}`. Use real Paws durable history, owner-only. Frontend can fetch next page with highest received seq, merge by id and sort seq. Do not claim unavailable history exists.
- Original AgentParty `/api/parties` routes remain backed by real vendored createPartyApi and same SQLite dir. POC uses its read/listen APIs; no route allowing arbitrary external party to control a Paws session.
- Party rich text envelope is encrypted as normal upstream text: `{v:1,text:string,images:ImageRef[]}`. Legacy non-envelope text remains displayable. Raw Paws events never included here.

### Task 1: Authenticated Party + Paws execution service

**Files:** Create `packages/paws-agent-party/{package.json,tsconfig.json,vitest.config.ts,.gitignore,UPSTREAM.md}`, vendor source/license, `src/contracts.ts`, `src/server/{http,auth,assets,party,runs,sdk,protocol,market}.ts`, `scripts/build-server.mjs`, `test/{service,runs,protocol,assets}.test.ts`. Modify workspace registrations/lockfile only. Focus modules by responsibility; additional small helper files allowed if justified in report.

**Interfaces:** Produces shared HTTP/types above. `createPocServer(options)` returns `{url,close()}` and accepts explicit test-injected SDK boundary; normal CLI bootstrap always creates the real SDK. Real SDK adapter can reuse old POC `remoteAgent.ts`/`protocol.ts` with attribution in UPSTREAM, but must not copy LangGraph consultation code. Existing old source path is `/Users/jacky/jacky-github/happy--consultation-poc/packages/paws-consultation/src`.

- [ ] Scaffold config and mechanically import needed upstream source. Preserve exact original file content unless needed for integration; record changes. Install filtered package dependencies with scripts disabled initially; build only SDK, no CLI or app build. Use versions already locked for common deps; use compatible explicit versions for newly added deps.
- [ ] RED: tests exercise real Party storage/API in temp dirs and a test-only remote SDK boundary; do not replace Party. Establish failures for remote run before auth, replayed requestId, wrong turn completion, failed agent, abort, images oversize/wrong type, unauthorized API and wrong Origin. Example behavioral assertions:

```ts
expect((await fetch(`${server.url}/api/consultations`)).status).toBe(401);
expect((await postStart(input)).id).toBe((await postStart(input)).id);
expect(publicMessages.some(m => m.text.includes('tool-secret'))).toBe(false);
expect(callsFor('trend30')).toHaveLength(2);
expect(callsFor('moderator')).toHaveLength(2);
```

- [ ] GREEN: implement contracts/service. Use Node HTTP wrapper around vendored createPartyApi; a configured or generated random access token is not a Paws credential. Default bind loopback. Static files from dist/web only. SDK account link via `startBrowserAccountLink`, memory CredentialProvider, safe async state/error cleanup; initial request is abortable. Redact nested transport error objects.
- [ ] GREEN: create local Party + host/roles on start, store run/idempotency index atomically under package-local ignored .data with restrictive permissions. Acquire single-process data-dir lock and release on close; do not kill unknown processes. Never auto-replay in-flight turns on restart. Use fixed mock dataset, model instructions explicitly synthetic. Actual task delivery consumes Party messages, then SDK sends, then sends public statements back with replyTo. Route by known role identities, never grant permission from message text.
- [ ] GREEN: validate attachments before allocation/use and load only known IDs beneath data dir. Bind input references to actual stored metadata; body size cap no greater than 11 MiB for one raw upload. Images forwarded to every relevant actual SDK turn. Preserve run/session links even for late spawn after stopping.
- [ ] GREEN: use watch-before-send and durable root-turn matcher. A model failure stops dependent rounds, reports failed not completed. Timeouts and stop remove subscriptions, no auto permission approval and no `sessions.stop()` as fake process cancellation. Follow-ups serialize per session and keep complete Party history as context within a bounded budget.
- [ ] GREEN: test known receive/send race in a pure delivery reducer introduced for Task 2; `receivedBatch(C1)` plus `ownSend(C3)` must leave next receive cursor at C1, with later C2 still merged and ordered. Export reducer from `src/timeline.ts` for UI use.
- [ ] Verify: `pnpm --filter @wangjs-jacky/paws-agent-party test`, `typecheck`, and server build. Record exact RED/GREEN outputs, SDK auth/live-run limitations, and create local commit. No live account authorization or spawning needed for unit tests.

### Task 2: Forked Party UI, graph-free conversation, acceptance entrypoints

**Files:** Extend vendored `src/ui/party/{chat,composer,message}.tsx`; adapt vendored `web/src/party-app.tsx` into `src/web/PartyApp.tsx` with original attribution; create `src/web/{main,ConnectionPanel,AgentDetails,api}.tsx/ts`, styles, index.html, Vite/build scripts, README, `test/{ui,connection}.test.tsx`, `test/acceptance-server.ts`, acceptance report. Only add fields compatible with Task 1 contracts; coordinate any server correction instead of hiding mismatches.

**Interfaces:** Consumes Task 1 HTTP/types/timeline reducer. Chat gains optional `onOpenParticipant(name)`, rich message renderer and composer extension hooks; retain original components and list/layout behavior. ConnectionPanel uses QR link status, never handles Paws account secret. AgentDetails consumes paginated durable message endpoint with seq-based append.

**Controller clarification (2026-09-16):** Task 1 omitted the approved design's root-turn/source-message association. Task 2 is authorized to add the minimal compatible contracts/protocol/run-store fields: persist Party task ID, returned public Party reply ID, SDK localId, exact session/rootTurnId and durable sourceMessageId, which explicitly labels the turn-end record. Render exact per-turn provenance in AgentDetails; never infer it from latest session or matching response text. Test multiple roles/turns and restart persistence. Older runs normalize `turns` to `[]`; Task 1's `followUps` is likewise required with old-record normalization. Follow-up active means queued/running; mixed failures do not hide surviving active recipients, and stop remains available during follow-ups even when initial run is terminal.

**Task 2 evidence boundary:** Automated SDK-boundary fixtures use real Party SQLite/encryption and the actual imported Chat/Composer/Sidebar. They do not satisfy real model or browser acceptance. UI Before is upstream `af00afbd49b3235c2084cff9849ef12353073484`; local Task 2 base `b18af4088a356dcb1169b82752b118a6db5b9c96` contains no runnable UI. A1/A3/live images and Ego browser verification remain pending; screenshot choice remains unanswered.

- [x] RED: rendered component tests catch clicking a participant changing recipient rather than opening details; image-only submission disabled; own send skipping an unseen received message; failed/stopped run shown as completed; disconnected state permitting model run. Use real Chat, not mocked UI.

```tsx
await user.click(screen.getByRole('button', {name: /查看.*trend30/}));
expect(screen.getByRole('dialog', {name: /执行详情/})).toBeVisible();
expect(screen.getByText(/远端可能继续/)).toBeVisible();
```

- [x] GREEN: preserve upstream Party layout and skin with semantic CSS tokens (no new per-component hardcoded surface colors). Keep react/Tailwind shell independent of Happy native Unistyles; no Tauri/Expo changes. Chinese labels for this POC, visible agents-party source link, constant Mock market banner. Adapt native timeline load/listen with the tested reducer and sorted/id-deduped merge, not a separate fabricated conversation.
- [x] GREEN: auth access token bootstrap from URL fragment (remove from address bar) or manual input, no credentials in assets/logs. Show SDK server URL + connect QR/status/disconnect, machine selector, explicit directory, per-role engine selects. Start form handles text, image-only, mixed; preview validated attachments and remove before sending. Disabled/busy/error states are accessible and explain missing prerequisites.
- [x] GREEN: offer single-Agent connection check and full consultation. Public timeline has eight actual Agent turns for full mode. Existing user addressing stays available for terminal-run follow-ups. Agent detail opens as right panel on wide viewport and touch-usable modal on narrow; shows status/sessionId, structured event summaries plus expandable raw record, pending permissions guidance and original Paws session link, paging/reconnect errors. Do not render hidden reasoning as promised data.
- [x] GREEN: stop label explicitly means stop coordination, late-created session remains visible. Switch/reload restores Party history and saved run state; server restart interrupted state not fake resumed. Fetch attachments with authorized API into revocable blob URLs; no token in image query URL.
- [x] Verify: package tests/typecheck/build, built HTTP app smoke with real Party storage. A test-only acceptance server may use deterministic SDK fixtures but must visibly say “测试替身，非真实 Agent”; no mock model switch in normal production start. Node fixture should use real SDK relay if practical; reuse prior test relay only if necessary and clearly separate.
- [x] README: exact pnpm commands, token handling, QR authorization, local-only access boundary, browser close vs server stop behavior, single data-dir restriction, why real-model acceptance can be blocked, upstream provenance. Include local-live start path that needs no code edits to use real SDK. Record base commit for UI Before, never claim screenshots/live tests if absent.
- [x] Create local commit and report exact verification commands and unresolved gate statuses. Controller performs independent review and Ego browser/live acceptance where authorized/available. Do not publish, push, open external tunnels, or create PR.

## Acceptance cases

| Case | User-visible criterion | Required evidence |
| --- | --- | --- |
| A1 | Normal Paws authorization; one real Agent answer appears in Party | Real SDK/live model, not fixture |
| A2 | Text/image-only/mixed input reaches agents; missing auth blocks run | Unit/integration + live image turn |
| A3 | Three timeframe analyses, one challenge round, moderator summary | Eight real turns; public Party history |
| A4 | Clicking role opens the matching session execution details | Exact session and durable trace correspondence |
| A5 | Stop/failure/reload/duplicate-submit do not lie or restart jobs | Focused tests + browser interaction where available |

No production release is in scope. If A1/A3 cannot run without the user's account approval, finish all safe code/testing work and report “部分完成（整体未完成）” with the one necessary authorization step.
