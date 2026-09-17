# Paws agents-party POC

## Current group-chat entry

The current release supports Codex-only reusable profiles, defaulting to
`gpt-5.6-luna` with `low` effort. Model IDs and effort are editable in **管理 Agent**;
rooms retain a snapshot, so profile edits affect newly created rooms only.

**自动辩论** is separate from **自动接话** and defaults off. Enable it, select
1–10 rounds (default 10), and mention exactly two members in one message. One
round means one reply from each member, so 10 rounds produce at most 20 replies.
The next speaker sees previous public statements. The stop button cancels local
observation/scheduling, not remote processes already running. Active debates are
interrupted after service restart and never automatically replayed.

The formal companion URL is `https://47.115.228.20:8443/agent-party/`, deployed
only by merged-main Web CI. It is a **single-owner POC**, protected by a separate
access token; do not share that token with untrusted users. Connect the owner's
Paws account by QR or recovery code after each service restart. Credentials stay
in process memory; persisted rooms/history live in `/var/lib/paws-agent-party`.
An unclean process exit may require the guarded stale-lock recovery below.
The deployment preserves a private data backup and the stopped prior container
for rollback. A page being reachable does not prove a Paws account is connected.

Real bounded-debate acceptance: [2026-09-18 report](docs/codex-debate-acceptance.md).
The following finance/preview sections are historical evidence, not the current
generic group-chat workflow or a claim that an old preview remains available.

The default page now opens the generic Agent library and group-chat UI. Configure
role instructions and Codex settings, invite those profiles into a room, and use inline
`@` mentions to address one or more members. With auto replies disabled, plain
messages only enter the history; enabled auto routing selects one member using
text/role relevance. The legacy finance consultation APIs remain available.

The generic entry passed a real two-session/four-response Paws acceptance on
2026-09-17. See [the live acceptance report](docs/group-chat-live-acceptance.md)
for the browser cases, verification, cleanup and remaining feature gaps. The
financial-POC instructions and older evidence below describe the legacy entry.

This is a source fork of [agents-party](https://github.com/1gr14/agents-party/tree/af00afbd49b3235c2084cff9849ef12353073484), with its real Party SQLite/API, Chat, Composer, Sidebar, virtualized lists and theme. Paws SDK runs the agents. Market data is always explicitly synthetic and is not investment advice. This is a local POC, not a deployment or trading tool.

## Build and normal live entry

From the worktree root, with Node 24 and pnpm 10.11.0:

```sh
pnpm install --filter @wangjs-jacky/paws-agent-party... --frozen-lockfile --ignore-scripts
pnpm --filter @wangjs-jacky/paws-agent build
pnpm --filter @wangjs-jacky/paws-agent-party build
pnpm --filter @wangjs-jacky/paws-agent-party start
```

The last command always constructs the real SDK. There is no mock-model switch in production. It prints a loopback URL and the **path** to its access-token file, never the token. Open that URL locally, copy the file's content into the password field, then connect to your Paws SDK server through its normal QR authorization. The default SDK server field is `http://47.115.228.20:3005`; edit it before linking if necessary. No Paws account secret belongs in this page. Credentials remain only in the service process memory.

An optional `#token=<local-access-token>` URL fragment bootstraps access and is immediately removed with `history.replaceState`; the fragment is never sent in an HTTP request. Prefer manual entry when sharing links or screens. The local token is retained in this tab's `sessionStorage` for reloads. Every API/attachment fetch uses a Bearer header. Images are fetched as authorized blobs and their object URLs are revoked on replacement/unmount. Do not put tokens in query strings or logs.

Choose an online machine and explicitly enter its working directory. Select each role's engine (`codex`, `claude`, `gemini`, `opencode`). Start with “单 Agent 连接检查”; “完整会诊” runs eight initial turns: moderator opening, three specialist analyses, three challenges, moderator synthesis. PNG/JPEG/WebP inputs support text-only, image-only, and mixed submissions: at most four files, each at most 10 MiB. Image support is model/provider-specific; the live checks below cover Codex on one Linux executor only.

Click a participant's name for durable execution details. Recipient chips independently address terminal-run follow-ups; no selection means moderator. Details show stored party/run/participant/task/public-message/localId/session/root-turn associations. `sourceMessageId` identifies the durable **turn-end event**, not a text fragment. Missing fields indicate an unobserved/unreached stage. Public history contains only statements and submitted tasks; raw SDK records remain in the owner-only details panel. Pending permissions must be handled in the linked original Paws session; this service never auto-approves them. The original-session link uses the project's Paws Web origin, `https://47.115.228.20:8443/session/<id>`.

“停止协调” ends coordination/observation; already accepted remote work may continue. It does not prove remote process termination. Late-created session IDs remain visible. Closing the browser leaves server work running. Stopping/restarting the service marks unfinished runs/follow-ups interrupted and never automatically replays them. Reopen the page to reload saved Party/run state; reconnect your Paws account to read remote details. Request IDs deduplicate accepted retries; there is no end-to-end exactly-once guarantee. If a submission response is uncertain, retry in the same dialog/draft to retain its request ID; closing/reloading discards that pending client draft, so check saved history before starting again.

Data defaults to `packages/paws-agent-party/.data`; an explicit directory can be supplied with `PAWS_AGENT_PARTY_DATA_DIR=/absolute/path`. Only one process may own a data directory. The service binds loopback and validates Host/Origin; do not expose it with a tunnel, reverse proxy, or public bind. Static assets are public on loopback; APIs and images are authenticated. Keep the data directory and access token private. No daemon/global CLI changes are required by this package.

#### Explicitly authorized temporary preview exception

On 2026-09-17 the owner explicitly authorized one independent Cloudflare Quick Tunnel for this POC, not a Paws Web deployment. The normal service's loopback boundary remains unchanged. `scripts/preview-gateway.mjs` supplies a separate password-authenticated gateway with one pinned HTTPS origin, authenticated APIs/images, mutation-Origin checks, no credential query strings, bounded requests and a maximum 24-hour lifetime. It must only be used with explicit authorization and lifecycle handling that closes the owned tunnel and backend when the gateway expires; the gateway module alone does not manage those processes. Never tunnel the normal service directly or share its original access token/account credentials.

The temporary preview was verified through its public URL: unauthenticated API calls were denied, invalid/missing mutation Origins were denied, real SDK readiness and saved history loaded, and Ego submitted one new single-Agent task to the selected Linux/Codex executor. Its response, “真实 Agent 连接正常”, matched the durable session/root-turn/turn-end record; the execution-details panel loaded successfully. This public smoke used no image and did not repeat the previous eight-turn acceptance. The UI is unchanged. The preview is deliberately left running for the owner's test and expires at **2026-09-18 03:00:04 Asia/Shanghai**, or earlier if its host/process/tunnel stops. Expiry revokes access and closes coordination, but does not guarantee termination of already accepted remote work. The new completed smoke session and all previous histories remain available; no remote workers were stopped for this preview handoff.

Gateway/lifecycle verification passed 12 tests in addition to the existing 67 package tests, typecheck and built HTTP smoke. The URL and independent password are delivered privately, not embedded in this README or front-end assets. This exception does not change the default loopback-only policy or authorize later previews.

### Recovering a verified stale `service.lock`

An unclean exit can leave `service.lock` behind. Startup deliberately fails closed rather than guessing ownership. Do not delete the data directory or kill an unfamiliar PID. Closing a browser does not stop its service or accepted remote work.

1. Stop automatic/manual restart attempts. Resolve the **exact** configured data directory to its canonical absolute path (including symlinks); use the launch configuration, not an assumed default. Read only that directory's `service.lock`, which contains `PID:nonce` (not an account credential), and note its contents and modification time.
2. Check that PID with `ps -p <PID> -o pid=,ppid=,lstart=,command=` and `lsof -p <PID>`; check all open files in the exact directory with `lsof +D /absolute/exact/data-directory`. Correlate the command, process start time, working directory, explicit data-directory configuration and open Party/SQLite files. A live matching owner means **do not remove the lock**; shut down only that positively identified service normally and let it release its lock. PID reuse is possible: a PID's existence alone does not identify the owner, and a missing PID or empty `lsof` output alone is insufficient if visibility/permissions are incomplete. Check for another process using the same canonical directory. If ownership cannot be established, stop and seek operator help; never kill an unknown process.
3. Only once no process owns that exact directory and no restart can race you, make a private backup of the **entire** directory, including Party SQLite files and any WAL/SHM files, run snapshots, assets and access token. Keep those data files untouched. Recheck the lock contents/time and process ownership immediately before recovery; any change means restart the checks.
4. Remove **only** the now-verified stale `service.lock` (for example `rm -i /absolute/exact/data-directory/service.lock`, replacing the example with the verified literal path). Do not use recursive deletion, wildcards or delete any run/Party data. Restart using the same directory and normal startup command. Unfinished saved runs become interrupted without automatic replay; reconnect the account normally. This does not establish that previously accepted remote work stopped.

This is a manual recovery procedure, not automatic stale-lock removal. Do not run its removal step merely because startup reports “already locked”.

## Test-only local entry

```sh
pnpm --filter @wangjs-jacky/paws-agent-party build
pnpm --filter @wangjs-jacky/paws-agent-party start:test
```

This explicitly separate entry injects `test/fake-sdk.ts` and labels the page **“测试替身，非真实 Agent”**. It uses real Party storage and encrypted message APIs, but deterministic SDK boundary fixtures, not an encrypted relay or a real model. Its default data is `.data-test`, separate from normal `.data`. It prints only the local URL and token-file path. This entry is useful for UI interaction checks and cannot satisfy live Agent acceptance.

## Verification and remaining gates

```sh
pnpm --filter @wangjs-jacky/paws-agent-party test
pnpm --filter @wangjs-jacky/paws-agent-party typecheck
pnpm --filter @wangjs-jacky/paws-agent-party build
pnpm --filter @wangjs-jacky/paws-agent-party exec tsx test/smoke.ts
```

The smoke test starts the built service twice in temporary directories: first its real, disconnected SDK adapter (HTML/assets/auth checks), then the explicit SDK fixture (eight turns through real Party SQLite/encryption plus durable provenance). It cleans up its own temporary data. Neither pass means a model ran.

Live acceptance on 2026-09-16 used the normal built service, its account-link approval flow, the real SDK and the user's selected Linux/Codex executor. No fixture was injected.

| Gate | Observed result |
| --- | --- |
| A1: real response | Passed through the API: a real moderator reply reached Party. A canonical session-envelope decoding defect found in the first live run was fixed and regression-tested. |
| A2: image input | Image-only and text-plus-image follow-ups completed in the same real session. The first image reply correctly identified a visual code absent from the prompt. Browser attachment interaction subsequently passed on 2026-09-17; other engines remain unverified. |
| A3: eight real turns | **Passed through the normal built POC/API.** After an approved temporary executor resource increase, four independent Codex sessions completed the moderator opening, three overlapping specialist analyses, three overlapping challenges and moderator synthesis. All eight replies recognized the supplied image's visual code. |
| A4: matching details | API verification passed for all eight real turns: public text and persisted session/root-turn/turn-end references match the actual durable records, with no pending permission requests. On 2026-09-17, browser switching between trend30 and timing1 details passed; all nine consultation/follow-up turns matched durable records. |
| A5: failure/retry/lifecycle | Same-request retries were deduplicated for the single run, follow-ups and full consultation; the two earlier failed consultation attempts remain recorded. On 2026-09-17, a timing1-only browser follow-up added exactly one turn, and reload after completion preserved the same run and nine public IDs. In-progress reload, stop and disconnection remain automated-only coverage. |

Read-only diagnosis found the local Docker executor by its persistent Paws machine ID; the remote display hostname/version were stale. Its daemon log confirms both failed workers exited with code 1 about 0.4 seconds after launch, then the daemon reported webhook timeout at 90 seconds. The SDK's 30-second acknowledgement deadline hid that later error; increasing the deadline alone would not fix the early exits. Existing sessions and directory RPC remained usable.

With the user's approval, the shared test container was temporarily raised from 2 to 4 GiB memory and 256 to 512 tasks, retaining a 2 GiB swap allowance and 2 CPUs. Neither the container nor daemon restarted. One controlled full consultation then passed in approximately 2 minutes 32 seconds to the last durable turn-end; a sample during concurrent work reached 476 tasks and about 2.94 GiB memory. Task-limit rejection and memory-limit/OOM counters did not increase. This validates the run under increased capacity, but does not isolate memory versus task limits as the sole cause of the historical early exits.

After terminal-state and ownership checks, only the four new test workers were stopped through the daemon's normal session-stop endpoint. All five pre-existing workers and all histories were retained. Five exited descendant zombies remain waiting for container PID 1 to reap them; no live process from this run remains. Resource rollback is **pending**: remaining memory was approximately 2.08 GiB, above the original 2 GiB budget, so limits were not forcibly reduced and no pre-existing worker was killed. The temporary 4 GiB/512-task limits remain in place pending the user's cleanup/continuation choice. The local acceptance service shut down normally; no account credential was persisted.

The latest code checks pass all 67 package tests, typecheck and built HTTP smoke; the protocol fix's build and scoped independent review also passed. On 2026-09-17, Ego exercised the normal built POC with real SDK/Codex: mixed input, four sessions/eight consultation turns, participant details, a timing1-only follow-up and completed-history reload. All nine public statements independently matched durable records. A 57.3-second H.264 acceptance video was decoded and visually checked, then delivered through Happy. Long unchanged waits were shortened; session identifiers were redacted. A selector correction split recording into segments without repeating model work.

Known POC UX limitations: internal host task instructions remain visible on the timeline; latest output required manual scrolling; role labels remain technical. Other engines and broader live failure/lifecycle scenarios remain unverified. No deployment, push or merge was performed.

Only the recording's four newly owned workers were stopped after terminal/provenance and process-ownership checks. All five pre-existing workers and histories remain intact. Six exited descendants await PID 1 reaping; no owned live process remains. The local service and owned Ego space closed normally. Resource rollback remains **pending**: remaining memory was about 2.12 GiB, above the original 2 GiB limit, so existing temporary 4 GiB/512-task capacity was retained. The requested browser/video delivery is complete; broader production acceptance and resource rollback are not.

UI Before source is upstream commit `af00afbd49b3235c2084cff9849ef12353073484`; local Task 2 base is `b18af4088a356dcb1169b82752b118a6db5b9c96`. There was no runnable local UI at that local base. See [UPSTREAM.md](./UPSTREAM.md) for imported paths, adaptations, and licensing. Fonts use system fallbacks with no external font requests.
