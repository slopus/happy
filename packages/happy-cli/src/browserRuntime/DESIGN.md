# Browser Runtime (Agent Browser PoC)

Plan/spec: Saydo `specs/agent-browser-poc/` (spec, plan, contracts, acceptance).
This file records the implementation decisions made at T01 and the module
boundaries. `contracts.ts` is the typed version of the plan's contract.

## T01 findings that shaped this

- Agent sessions are spawned by the Happy daemon as detached children
  (`daemon/run.ts` spawnSession). Nothing aborts a turn when the Desktop client
  disconnects; only abort/stop/archive/idle-reaper end it. Follow-up messages go
  through the server (`POST /v3/sessions/:id/messages`, `happy agent prompt`).
- Existing `mcp__happy__browser_*` tools go session MCP → daemon `/browser/request`
  → extension WebSocket. A missing `tabId` falls back to the active tab inside
  the extension (`protocol.js` resolveTab).
- No SQLite dependency; durable state elsewhere uses temp-file + fsync + rename
  + directory fsync (`checkpoint/checkpointTurnApplyJournal.ts`). `node:sqlite`
  is unavailable on the supported Node 20 floor, so TaskStore reuses that
  pattern (no new dependency).
- Agents are not sandboxed by default and can read `~/.happy`. Runtime secrets
  therefore never live under `~/.happy` and never on the agent's host
  filesystem: the Runtime, Chromium, profile and journal run in Linux
  containers; the host only holds an agent grant (whose power equals the agent
  tool surface) and the harness issuer key under a harness-only directory.

## Topology (PoC substitute for "separate Linux execution machine")

```
macOS host (execution machine H' + client C on the same box — see results)
  Happy daemon + real agent session (claude)       Desktop (Electron) = client C
     │ MCP tools browser_task_* (agentTools.ts)        │ console / approve / takeover
     ▼                                                 ▼
  127.0.0.1:<runtime-port> ── HTTP JSON (bearer grant / interactive capability)
  ┌──── docker networks abp-<runId>-a / -b (OrbStack Linux), one per browser ────┐
  │ runtime container: node runtimeMain (TaskStore volume, writer lock)   │
  │    └─ CDP over ws ─► browser container(s) per profile:                │
  │         Xvfb + Chromium (--remote-debugging-port, internal only)      │
  │         + noVNC (published 127.0.0.1) + browserInstanceId file        │
  │ fixture container: site A (a.poc-one.test), site B (b.poc-two.test), │
  │    control/ledger API (harness token), barrier                        │
  └───────────────────────────────────────────────────────────────────────┘
```

## Modules (src/browserRuntime)

| File | Responsibility | Must not |
|---|---|---|
| contracts.ts | IDs, DTOs, error codes, limits, driver port, API port | I/O |
| taskStore.ts | durable task/action/approval/event records, dedupe, seq, writer lock + fencing, quota | know about CDP |
| stateMachine.ts | pure transition rules (status × event → status), pause reasons | I/O |
| inputLease.ts | per-tab owner/epoch/segment, profile-wide user fence | persist by itself |
| policy.ts | origin allowlist, fixture action risk classes, approval binding hash, redaction | trust page text |
| auth.ts | grant/capability sign+verify, revocation list | accept identity from request JSON |
| runtime.ts | BrowserRuntimeApi: all operations, batch worker, cancel fence, recovery | hold a lock across driver awaits |
| drivers/cdpDriver.ts | explicit target CDP driver, OOPIF, refs, screenshot, trusted input | active-tab fallback, Runtime.evaluate exposure |
| server.ts / runtimeMain.ts | HTTP transport, health, single instance | business rules |
| agentTools.ts | MCP tool surface for the agent (claude/utils/startHappyServer wiring) | approve/takeOver |

Harness and fixture: `scripts/browser-poc/` (fixture server, container images,
runner, A01–A12 scenarios). Unit tests next to modules (`*.test.ts`, unit
project). Browser E2E suites are `src/browserRuntime/e2e/*.poc.test.ts` in the
`browser-poc` vitest project (needs docker).

## As built (2026-09-25)

- Each browser container sits on its own network (`abp-<run>-a` / `-b`); the Runtime and
  the fixture join both, so a browser or page can never reach the other profile's CDP.
  The CDP proxy accepts only `Host: browser-<profile>:9223`; noVNC needs a per-run password.
- Owned tabs are opened as background windows (a background tab in the user's window is
  hidden in a headful browser and cannot be captured), capped per profile (see "Agent windows").
- Refs resolve only against snapshots the agent received; dispatch-time checks use
  `describeRef` (no new snapshot). Approvals persist a structural element identity so a
  pending approval survives a Runtime-only restart when document and node are unchanged.
- Writer lock = heartbeat lease (5 s refresh, stale after 20 s) + fencing token;
  `runtimeMain` waits for a dead writer's lease to expire before giving up.
- Acceptance results, gates and the No-go verdict: Saydo `specs/agent-browser-poc/results.md`.

## Deployment readiness (S2, 2026-09-25)

Saydo `specs/agent-browser-deploy/` D3 (verify), D4, D8, D9, D10 (Runtime side).

- Modes: without `ABP_CONFIG_FILE` the Runtime runs exactly as the PoC harness (abp1 keys file,
  TCP admin with bearer). With `/etc/abp/runtime.json` (`runtimeConfig.ts`, schema-validated)
  identity, profile owners (`profiles[].principalId`) and `trustedIssuers` come from the file.
  `authMode: "production"` accepts interactive capabilities only as `abp2` (Ed25519, `aud` =
  machineId, `iss` = saycode-server, lifetime ≤ 5 min), keeps internally minted abp1 agent
  grants, creates the agent key inside the state volume, and serves admin on a 0600 unix socket.
- Broker (`broker.ts`, `/run/abp/broker.sock` 0660): the daemon registers at spawn (the Happy
  session id does not exist yet), binds the registration when the session reports its id, and
  revokes it at exit; session processes get 55-minute grants with their per-session secret
  (`brokerGrantSource.ts`) and renew 5 minutes early. `GET /v1/attention` serves the outbox.
  Registry changes, issuance and revocation are serialized after the request body is read.
  Every revocation attempt first persists a `revoking` tombstone (issuance blocked, grant ids
  kept; registry rename + directory fsync), revokes each grant, then drops the registration.
  From start-up, tombstoned grant ids are on the task API's credential denylist
  (`withRevokingGrants`, broker started before the API) and `/v1/ready` reports
  `revocations: false` until the background replay (retried) finishes them. The daemon keeps
  unconfirmed revocations in `~/.happy/browser-task-revocations.json` (exclusive temp file,
  fsync, rename, directory fsync; failed writes retried) and retries them with backoff
  (≤ 5 min) across restarts; an unreadable or malformed queue disables the daemon broker
  instead of being read as empty.
- Attention outbox (`attention.ts`): transitions are tagged `data.attention` at commit time
  (approval decided, takeover released, user resume, recovery); the outbox observes TaskStore
  commits and `reconcile()` repairs a crash between the task commit and the outbox write.
  Readers see only sequences already on disk (a failed write is retried), so repair never
  reassigns a sequence the daemon acknowledged. A per-task `unresolved` index, independent of
  the 1,000-event retention, feeds the `CURSOR_EXPIRED` snapshot. Expiry: `afterSeq + 1 < oldestSeq`.
- User resume (D8): interactive `resume` only from `user-input-complete`, and only while the
  task's stored grant is valid; approval waits, uncertain writes, cancel requests and
  browser replacement are never released by the user. Completion uses the same rules as the
  agent's resume (`userWaitCompleted`): a handoff needs no check (the agent re-observes), a
  login needs the site's `loginCompleteWhen`, other waits their predicate; a wait without a
  recorded condition is refused. The final write rechecks task state, grant validity and
  input ownership, since the login check awaits the browser, and records `user-resumed`.
- Task space reclamation (spaces otherwise outlive aborted sessions and fill
  `maxSpacesPerProfile`, which is runtime.json config, default min(4, maxAgentWindows); the
  harness keeps the PoC limit of 2):
  - Session end: the broker's session revocation calls `endSession` under the tombstone
    (failure or crash retried like a grant revocation). The session's spaces are durably
    marked `reclaimReason: 'session-ended'` and its unfinished tasks go through the cancel
    fence.
  - `reclaimSpaces` (at start, every 30 s, and right after a session ends) closes marked
    spaces tab by tab once no batch is running. It also closes spaces whose tasks are all
    finished and that were idle for `spaceIdleReclaimMs` (default 15 min; harness only with
    `ABP_SPACE_IDLE_RECLAIM_MS`). Closed or reclaiming spaces refuse `createTask` and
    `openPage` (CONFLICT, "create a new task space").
  - Retained work: a task whose write outcome is unknown stays paused
    (`cancelled-with-unknown-effect`, visible in the console) with its space and tabs. That
    space no longer counts against the quota, except reclaiming spaces beyond 2 per profile
    (`RECLAIMING_SPACE_RESERVE`), so a pile-up still surfaces as `QUOTA_EXCEEDED`. The
    operator reconciles the action (admin `reconcile-action`) or force-closes the space.
    Its windows still count toward `maxAgentWindows`.
  - A tab blocking unload stays open, is recorded in `reclaimBlockedTabs` and reported, and
    is retried on each pass.
  - Operator: admin socket `GET /admin/spaces` (owner session, tasks, tabs, age, counted)
    and `POST /admin/close-space { taskSpaceId, force? }` (cancel, then close; `force`
    also closes a space with unknown-outcome tasks, whose records stay for reconcile).
    TODO (S6 installer stream): wire `abp-stack spaces list|close <id> [--force]` to these.
- Retention (`retentionDays`, config mode, at start and hourly): terminal tasks without
  uncertain actions whose last change is older than the retention are deleted
  (`BrowserRuntime.purgeExpiredTasks`). Their still-open browser tabs are closed first and
  only then dropped from the space; if one cannot be closed (browser unreachable,
  beforeunload, a user holding it) the task keeps all its state and the next run (also after
  a restart) retries. The store never deletes a task whose tab is still open. The task
  directory (journal, checkpoint with approvals,
  batches and request records) is renamed into `tasks-purged/` — the commit point — then the
  space references (tabs, targets, lease epochs, request records naming the task) are dropped
  and the directory removed; an interrupted deletion finishes on the next open or run. The
  attention outbox forgets the task's cursor and unresolved entry (or prunes them at
  reconcile after a crash); its old feed events age out.
- Writer lock (D9): the image entrypoint runs `exec flock -n -E 75 -F <state>/runtime.flock node`;
  production refuses to start unless `/proc/locks` shows this pid holding it. The heartbeat
  lease and fencing token stay. The Runtime runs as uid 10870 (no host login user).
- Production start (`privilegeDrop.ts`): the installed permissions are `/etc/abp/runtime.json`
  root 0600 and `/run/abp` root:abp-session 0750, so the container starts as root with only
  SETUID/SETGID (`--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
  --security-opt no-new-privileges`). The entrypoint creates the state dir and lock file as the
  runtime user; node reads the config, binds broker (root:abp-session 0660, group by
  membership) and admin (root 0600) sockets, then drops to `ABP_RUNTIME_UID/GID` and exits if
  any capability is left. If that fails it closes the sockets and exits before the state
  volume, any browser or the task API is opened (`runtimeProcess.test.ts`). The production
  smoke audits `/proc/1/fd`: no config descriptor, one `runtime.flock`, the two listeners.
  The harness still runs the image as uid 10870 directly.

  lease and fencing token stay. The container runs as uid 10870 (no host login user).

## Runtime viewer (S4, 2026-09-25)

Saydo `specs/agent-browser-deploy/` D2. Files: `viewerProxy.ts`, `rfb.ts`, `server.ts` routes.

- `POST /v1/ops/viewerTicket` (interactive operation) → one-time ticket, 30 s or the capability's expiry,
  bound to the capability and profile. `GET /v1/viewer/websockify?ticket=` spends the ticket even when
  refused.
- **Authorization boundary = the ticket.** It is obtainable only with a live interactive capability
  (server-signed abp2 in production) for that profile, 256-bit random, single use, ≤ 30 s, and the
  connection stays bound to the capability (expiry/revocation close it; input additionally needs the
  capability's viewer to own the takeover lease).
- `Origin` is defense in depth, not a boundary. Accepted: a configured `viewerOrigins` entry, or any
  http loopback origin when the Host is a loopback literal. That refuses other sites' pages reaching the
  Runtime port directly and DNS-rebound names, but behind the Saycode machine tunnel it proves nothing:
  the happy-server preview relay rewrites Origin to loopback, so every relayed viewer passes it. The
  contract line "Origin은 Runtime 자기 origin 또는 설정된 터널 origin만" is therefore not an effective
  control through the tunnel; checking the viewer page's real origin would have to happen at the relay.
- Two independent RFB sessions per connection: RFB 3.8 server to the viewer (security None — the ticket
  authenticated it; desktop name replaced), RFB client of x11vnc (VNC authentication with the per-run
  password, shared). x11vnc listens on the profile network (no `-localhost`), is never published.
- Viewer→upstream: every message is parsed (`rfb.ts` generator parsers + `StreamFramer`). SetPixelFormat,
  SetEncodings (≤ 64, filtered to Raw/CopyRect/Hextile/DesktopSize/Cursor) and
  FramebufferUpdateRequest pass. Key/Pointer/ClientCutText (≤ 64 KiB) pass only while every user-owned
  tab of the profile belongs to this capability's viewer, no takeover is settling and the capability is
  live. Each change of that state bumps an authorization epoch (`InputLeaseManager.subscribe`, admin
  revocation calls `ViewerProxy.revokeCapability` synchronously). An input message is bound to the epoch
  at its type byte, checked when complete and again right before `socket.write` (queued input under
  backpressure); a mismatch discards it without losing framing. At most 16 distinct keys are held.
- Control loss: queued input is dropped. With no input ever written the connection stays view-only.
  Otherwise bytes may already be in flight, so the proxy writes key-up / button release for what was
  actually written (not queued intent), sends EOF, closes the viewer (4002 = reconnect with a new
  ticket; 4001 on capability expiry/revocation) and fences the profile (`InputLeaseManager.fenceProfile`)
  until x11vnc closes its side. The fence blocks every new input owner: agent acquire and user
  takeOver get STALE_LEASE, and `userControl` reports settling, so a replacement viewer (even one of the
  same viewer session that still owns the lease) gets no input through until the drain completes.
  Setting and lifting a fence notify viewers. x11vnc processes messages in order and
  closes only after reading EOF, so its close proves the input and releases were consumed; a
  FramebufferUpdateRequest round-trip cannot (libvncserver merges requests and may answer an older one).
  A hung x11vnc keeps the fence (fail closed, logged after 10 s). An agent step or a takeover during the
  fence gets STALE_LEASE before any intent or lease change is written.
- Upstream→viewer: framed, not byte-passthrough. The server stream's lengths follow from headers only
  for the filtered encodings, so the proxy validates every header (message type, rectangle inside the
  framebuffer, encoding actually requested, ZRLE/cut-text length bounds) before forwarding and streams
  the payload. A malformed or unexpected server message closes the connection (1011) instead of reaching
  the viewer's decoder. Tight and ZRLE are not offered: their zlib payload could only be bounded by
  inflating it in the Runtime (a 1x1 ZRLE rectangle can expand to 512 KiB). Cost: noVNC uses Hextile
  (more bandwidth over the tunnel).
- `/viewer/` serves the pinned noVNC client (Runtime image copies Debian bookworm `novnc=1:1.3.0-1`,
  no CDN; `vnc_lite.html?path=v1/viewer/websockify%3Fticket%3D…`).
- Harness: `poc.mjs up --viewer runtime` (pocStack `viewer: 'runtime'`) is the production layout — no
  websockify, nothing published but the Runtime. The default harness layout still starts and publishes
  noVNC (`ABP_HARNESS_NOVNC=1`) because A11 probes it directly; A04/A09 inject human input with xdotool
  on the display and do not depend on either viewer. The browser image starts websockify only when
  `ABP_HARNESS_NOVNC=1`.

## Deployment readiness (Saydo `specs/agent-browser-deploy/`, S5: D5–D7)

### Agent windows (D5)

Spike 2026-09-25 against the pinned headful Chromium 153.0.8010.52 (`abp-browser:pocfix`,
Xvfb, no window manager), reproducible with `scripts/browser-poc/spikes/window-placement/`.

| Question (anchor pool: driver-owned anchor tab per window, task tab via `window.open('about:blank','_blank','noopener')`) | Result |
|---|---|
| Lands in the anchor's window as its active tab | yes (every run); `window.open` returns null, target has `openerId` but `canAccessOpener: false` |
| Attach via `Target.targetCreated` + `attachToTarget` | yes |
| Paints for `Page.captureScreenshot` while other windows exist | yes (two task tabs in two anchor windows, exact colours) |
| Closing the task tab keeps the window/anchor; `beforeunload` still blocks `Page.close` | yes / yes |
| Anchor closed while a task tab is in its window | task tab survives, window stays (becomes unpooled) |
| **Does not take focus from the user's window** | **no: X input focus moved to the anchor window 3/3, a typed key reached the task tab 3/3.** `createTarget(newWindow, background)` kept focus 3/3 |

Memory (sum over Chromium processes in the container):

| | per window RSS / PSS | browser_ui targets per window | 400-window churn PSS (first 50 → 400) |
|---|---|---|---|
| default | +147 / +40 MiB | 2 (`chrome://omnibox-popup.top-chrome/…`) | 349 → 487 → 472 MiB |
| `--disable-features=WebUIOmniboxPopup,WebUIOmniboxAimPopup,WebUIOmniboxFullPopup` | +130 / +23 MiB | 0 | 340 → 387 → 422 MiB |

Decision: the anchor pool is **not** used (focus theft would send the viewer's keystrokes into an
agent tab). Instead: one background window per owned tab as before, at most `maxAgentWindows`
(default 4, `ABP_MAX_AGENT_WINDOWS`, ≤ tab quota) per profile, and the omnibox WebUI features off
in the browser image. Accounting (review P1-8): one reservation per target — taken before
`createTarget`, moved to the live target in the same tick, released only on `targetDestroyed`
(a failed cleanup keeps it); popups of owned tabs count too, and a popup over the cap is closed
with every request of it failed. Whether this meets the 30-minute soak criterion is measured by
`soak.mjs`, which reports cgroup memory and the Chromium process RSS sum separately.

### Destinations before requests (review P0-3)

The driver auto-attaches every new page at browser level, paused (`waitForDebuggerOnStart`).
Owned tabs, their OOPIFs and workers, and their popups (recursively, including `noopener`) get
`Fetch.enable` before they run; other pages are released at once. Document, XHR, Fetch, Ping,
EventSource, CSP-report and Other requests whose destination is not an allowed origin of the tab
are failed unsent (redirect hops included); subresources (script, style, image, font, media) are
not checked. A popup whose document is stopped is closed. `blockedReports()` keeps origins only.
Not covered: WebSocket/WebTransport/WebRTC, service-worker-initiated fetches, subresource GETs.
A paused target answers only Fetch/auto-attach until resumed, and a same-site popup shares its
opener's renderer (over the cap it is resumed with its requests failed). Fail closed (integration
review P0-3): if interception (`Fetch.enable`) or recursive auto-attach cannot be established for a
popup or frame — or auto-attach for a worker, whose requests pause in its parent's session (workers
have no Fetch domain) — the target is never resumed: a popup is closed while paused, a frame or
worker stays paused, and the owning tab refuses further work (`RUNTIME_UNAVAILABLE`, `closeTab`
still allowed). Fault-injection hook: `testHooks.guardFailure`.

### Approval binding (D6)

- `describeRef` returns the complete form submission (`FormSubmission`): absolute action,
  method, enctype, effective target (own, else `<base target>`), every entry in submission order
  (duplicates kept), the submitter with `formaction/formmethod/formenctype` overrides. Built by
  hand (no `formdata` event) through `HTMLFormElement.prototype` getters. `formDigest` = SHA-256 of
  its canonical JSON. A form whose content cannot be bound — a non-empty password, a chosen file,
  a form-associated custom element — is `opaque`: its submit/form click is handed to the user
  (`awaiting-user`, `waitReason: 'handoff'`), never approved (review P0-5).
- The approval payload hash binds the digest, the live role/name, link URL and target. The
  persisted summary is value-free: method, destination without query, new-window flag, field
  names (review P0-6). The user sees the values in the viewer.
- Approve and dispatch re-describe the element; a different identity, digest, label or document
  expires the approval. The click carries the expectation into the driver (`DriverOptions.expect`),
  which re-checks it after the hover and arms a one-shot in-page guard: a capturing `submit`
  listener recomputes the submission and cancels a changed one; a `formdata` listener compares the
  final entries and destination. Verdicts reach the driver through an isolated-world binding
  (Runtime domain on only while armed). Independently of those page events (which a page can
  suppress), the submission candidate — the next document request of the form's frame, or of any
  frame/popup of the tab when the form targets another context — is verified at interception time,
  after every page handler ran (reviews P0-1, A1): method, URL with query and body (urlencoded,
  multipart, text/plain) must equal the approved submission (`drivers/submissionCheck.ts`), else it
  is not sent; a substituted navigation or an unverifiable request is not sent either.
- Driver checks right before input: same-node relabel → `STALE_REF`; for elements in iframes
  every ancestor document must hit the iframe element at the click point. A transformed or
  zoomed iframe (or ancestor) is not guessed: handed to the user (review P0-7).
- Limits: purely visual relabels (CSS `content`, images, canvas); JS that sends data itself
  (e.g. `fetch` in a click handler) to an allowed origin; a JS navigation of the form's frame right
  after a click on a form element is refused as a non-matching submission (conservative); step
  payload hashes in the journal are unkeyed.

### Site policy (D7)

- `sites: [{ origin, actions: [{ match, risk }], loginCompleteWhen }]` (`policy.ts`,
  `ABP_SITE_POLICY` JSON, validated strictly; required at startup). Match conditions: `kinds`
  (navigate, link, submit, form-click, click, fill), `targetPaths`/`pagePaths` (exact or `prefix*`),
  `namePrefixes`, `roles` — no regular expressions. First matching rule wins.
- Origins without a policy cannot be opened; the agent grant's origins are narrowed to sited
  origins for every navigation/redirect/observation.
- Decisions: `auto`, `requires-approval`, `handoff`, `deny`. Refused outright: destinations that
  are not http(s) (`javascript:`, `data:`, `vbscript:`, `mailto:` …) or not sited, for navigation,
  links and forms. A link inside a form is a form click. Unmatched submit / form click / other
  click / fill → approval (fills via the approval flow, value never persisted); links outside forms
  and navigation → automatic. `openPage` applies the navigation rules (a held page is not opened,
  `APPROVAL_REQUIRED`); a navigate step held by policy is handed to the user (review P0-1/2).
  Held for approval regardless of rules: elements without a snapshot label, elements in frames of
  unsited origins.
- After a handoff the user takes over, acts, releases; `resume` returns the task to
  `awaiting-agent` without re-running the step.
- Login completion uses the site's `loginCompleteWhen` (URL prefix + optional text/element);
  login *detection* is still the fixture's `/login` path rule.
- Harness mode: `testing/fixtureSitePolicy.ts` reproduces the PoC classifier for the synthetic origins.
