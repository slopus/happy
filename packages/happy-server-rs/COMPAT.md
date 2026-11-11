# happy-server-rs compatibility checklist

The complete surface of `packages/happy-server` (TypeScript) that the Rust server
must reproduce. A box is ticked when the Rust implementation exists **and** the
differential harness (`compat/`) compares it against the TS server.

Persistence is unchanged: the Rust server reads and writes the TS server's Prisma
schema as is (no extra tables, no migrations of its own), so both servers can be
swapped on the same database at any time. It is a single process (no Redis) that
uses every allocated core; a Postgres advisory lock stops a second instance from
starting against the same database.

Legend: `A` = requires `Authorization: Bearer <token>`, `S` = zod schema
validation (params → body → querystring, before auth), `R` = zod response schema
(strips unknown keys, reorders keys to schema order).

## HTTP framework behavior (Fastify 5 + fastify-type-provider-zod 6)

- [x] `access-control-allow-origin: *` on every response (`@fastify/cors`, origin `*`)
- [x] CORS preflight: `OPTIONS` + `access-control-request-method` → 204,
      `allow-methods: GET, POST, PUT, PATCH, DELETE`, `allow-headers: *`
- [x] 404 handler: `{"error":"Not found","path":<raw url incl. query>,"method":<m>}`;
      unknown method on a known path is also this 404 (no 405)
- [x] Error handler: `<500` → `{error: err.name, message, statusCode}`;
      `>=500` → `{error:"Internal Server Error",message:"An unexpected error occurred",statusCode}`
- [x] Validation errors: 400, `error:"Error"`, message
      `"<body|params|querystring>/<path> <zod message>"` joined by `", "`; first failing part only
- [x] JSON body parser (global, from `connectRoutes`): empty body → `{}` (POST/PUT/PATCH) or
      `undefined` (DELETE/GET); invalid JSON → 400 `SyntaxError` with the V8 message
- [x] `text/plain` body → string; `application/octet-stream` → raw bytes;
      other types → 415 `FastifyError` `Unsupported Media Type: <type>`
- [ ] Body limit 100 MB (10 MB on session avatar PUT) → 413 `FastifyError`
- [x] Query parsing like `fast-querystring` (repeated keys → array, `+` → space)
- [x] `z.coerce.number()` uses JS `Number()` semantics on strings
- [x] Automatic `HEAD` for every `GET` route
- [x] `content-type: application/json; charset=utf-8` for objects, `text/plain; charset=utf-8` for strings
- [x] JSON output identical to `JSON.stringify` (number formatting, escaping, omitted `undefined`)

## HTTP routes

### Misc
- [x] `GET /` → `Welcome to Happy Server!` (text) — only without a static webapp dir
- [x] `GET /health` → `{status, timestamp(ISO), service}` / 503 on DB failure
- [ ] `GET /files/*` (local storage only): public file serving, 403 on traversal and on session avatars
- not ported: backend-only. Static webapp + SPA fallback + `__HAPPY_CONFIG__` injection (`HAPPY_STATIC_DIR`, `HAPPY_INJECT_HTML_CONFIG`) exist only in the standalone/self-host entry (`standalone.ts`, PGlite); the Rust server targets the hosted `main.ts` deployment
- [ ] Metrics server (`METRICS_PORT`, default 9090, `METRICS_ENABLED`): `GET /metrics`, `GET /health`

### Auth (`authRoutes.ts`)
- [x] `POST /v1/auth` S — ed25519 challenge, upsert Account by uppercase-hex key, `{success, token}`
- [x] `POST /v1/auth/request` S R — terminal auth request (`supportsV2`), `{state}` / `{state, token, response}`
- [x] `GET /v1/auth/request/status` S R
- [x] `POST /v1/auth/response` A S
- [x] `POST /v1/auth/account/request` S R
- [x] `POST /v1/auth/account/response` A S
- [x] Token: privacy-kit persistent token (EdDSA JWT, key = PBKDF2-SHA512(secret, "handy Persistent Token", 210000)[0..32]); token cache semantics

### Account (`accountRoutes.ts`)
- [x] `GET /v1/account/profile` A
- [x] `GET /v1/account/settings` A R
- [x] `POST /v1/account/settings` A S R — version CAS, `update-account` to user-scoped
- [x] `POST /v1/usage/query` A S — local-time hour/day bucketing

### Sessions (`sessionRoutes.ts`, `v3SessionRoutes.ts`)
- [x] `GET /v1/sessions` A — 150 by `updatedAt desc`, `lastMessage: null`
- [x] `GET /v2/sessions/active` A S
- [x] `GET /v2/sessions` A S — `cursor_v1_<id>` paging by `id desc`, `changedSince`
- [x] `POST /v1/sessions` A S — create-or-load by tag, project link, `new-session` / `update-session`
- [x] `GET /v1/sessions/:sessionId/messages` A S — 150 by `createdAt desc, seq desc`
- [x] `POST /v1/sessions/:sessionId/archive` A S
- [x] `DELETE /v1/sessions/:sessionId` A S — cascade + `delete-session` + blob cleanup
- [x] `GET /v3/sessions/:sessionId/messages` A S — `after_seq`/`before_seq`/`limit`/`hasMore`
- [x] `POST /v3/sessions/:sessionId/messages` A S — localId dedup, batch seq, `new-message`

### Session avatars (`sessionAvatarRoutes.ts`)
- [ ] `POST /v1/sessions/:sessionId/avatar/request-upload` A S — 60/min/account limiter
- [ ] `PUT /v1/sessions/:sessionId/avatar/:avatarFile` A S — local only, immutable (`wx`), 409 on differing bytes
- [ ] `PATCH /v1/sessions/:sessionId/avatar` A S — serializable tx, `update-session` with `avatar`/`avatarVersion`
- [ ] `DELETE /v1/sessions/:sessionId/avatar` A S
- [ ] `POST /v1/sessions/:sessionId/avatar/request-download` A S
- [ ] `GET /v1/sessions/:sessionId/avatar/:avatarFile` A S — local only, `cache-control: private, no-store`

### Attachments (`attachmentRoutes.ts`)
- [ ] `POST /v1/sessions/:sessionId/attachments/request-upload` A S R — limiter, presigned POST policy (S3) / PUT URL (local)
- [ ] `PUT /v1/sessions/:sessionId/attachments/:attachmentFile` A S R
- [ ] `POST /v1/sessions/:sessionId/attachments/request-download` A S R
- [ ] `GET /v1/sessions/:sessionId/attachments/:attachmentFile` A S — bytes (local) / 302 to presigned GET (S3)

### Push (`pushRoutes.ts`)
- [ ] `POST /v1/push-tokens` A S R
- [ ] `DELETE /v1/push-tokens/:token` A S R
- [ ] `GET /v1/push-tokens` A
- [ ] `POST /v1/sessions/:sessionId/push-event` A S R — `session-event` ephemeral, presence suppression, Expo send (8 s deadline)

### Connect (`connectRoutes.ts`)
- [ ] `GET /v1/connect/github/params` A R — ephemeral state token (5 min)
- [ ] `GET /v1/connect/github/callback` S — OAuth exchange, avatar upload + thumbhash, redirects
- [ ] `POST /v1/connect/github/webhook` S R — HMAC verification (`@octokit/webhooks` semantics)
- [ ] `DELETE /v1/connect/github` A R
- [ ] `POST /v1/connect/:vendor/register` A S — KeyTree AES-GCM encrypted token
- [ ] `GET /v1/connect/:vendor/token` A S R
- [ ] `DELETE /v1/connect/:vendor` A S R — 500 when missing (Prisma `delete` throws)
- [ ] `GET /v1/connect/tokens` A R

### Machines (`machinesRoutes.ts`)
- [ ] `POST /v1/machines` A S — create-or-load, 409 `machine_id_taken`, `new-machine` + `update-machine`
- [ ] `GET /v1/machines` A — bare array
- [ ] `GET /v1/machines/:id` A S
- [ ] `DELETE /v1/machines/:id` A S — deletes access keys, `delete-machine`

### Artifacts (`artifactsRoutes.ts`)
- [ ] `GET /v1/artifacts` A R
- [ ] `GET /v1/artifacts/:id` A S R
- [ ] `POST /v1/artifacts` A S R
- [ ] `POST /v1/artifacts/:id` A S R
- [ ] `DELETE /v1/artifacts/:id` A S R

### Access keys (`accessKeysRoutes.ts`)
- [ ] `GET /v1/access-keys/:sessionId/:machineId` A S R
- [ ] `POST /v1/access-keys/:sessionId/:machineId` A S R
- [ ] `PUT /v1/access-keys/:sessionId/:machineId` A S R

### Projects (`projectRoutes.ts`)
- [ ] `POST /v1/projects` A S — create-or-load by `externalId`
- [ ] `GET /v1/projects` A S — `ids`, `changedSince`
- [ ] `GET /v1/projects/:projectId` A S
- [ ] `PATCH /v1/projects/:projectId` A S — strict body, 409 on version mismatch
- [ ] `PATCH /v1/projects/:projectId/avatar` A S
- [ ] `DELETE /v1/projects/:projectId/avatar` A S
- [ ] `DELETE /v1/projects/:projectId` A S — unlinks sessions (`update-session` with `projectId: null`), `delete-project`
- [ ] `POST /v1/projects/:projectId/avatar/request-upload` A S — limiter (checked before ownership)
- [ ] `PUT /v1/projects/:projectId/avatar/:avatarFile` A S
- [ ] `POST /v1/projects/:projectId/avatar/request-download` A S
- [ ] `GET /v1/projects/:projectId/avatar/:avatarFile` A S

### KV (`kvRoutes.ts`)
- [ ] `GET /v1/kv/:key` A S R
- [ ] `GET /v1/kv` A S R
- [ ] `POST /v1/kv/bulk` A S R
- [ ] `POST /v1/kv` A S R — serializable all-or-nothing, `kv-batch-update`

### Feed / social (`feedRoutes.ts`, `userRoutes.ts`)
- [ ] `GET /v1/feed` A S R — `0-<counter>` cursors; bad cursor → 500
- [ ] `GET /v1/user/:id` A S R
- [ ] `GET /v1/user/search` A S R — `ILIKE prefix%`, 10 results
- [ ] `POST /v1/friends/add` A S R — relationship state machine + feed notifications (24 h cooldown)
- [ ] `POST /v1/friends/remove` A S R
- [ ] `GET /v1/friends` A R

### Voice (`voiceRoutes.ts`)
- [ ] `POST /v1/voice/conversations` A S R — ElevenLabs usage paging, 7200 s cap, token + conversation id
- [ ] `GET /v1/voice/usage` A R

### Version / dev
- [ ] `POST /v1/version` S R — node-semver `>=1.4.1` for ios/android
- [ ] `POST /logs-combined-from-cli-and-mobile-for-simple-ai-debugging` S — only with `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING`

## Socket.IO (`socket.ts`, `socketConfig.ts`)

Transport: Engine.IO v4 at path `/v1/updates/` (trailing slash required; `/v1/updates?` is
a Fastify 404), `websocket` + `polling` with upgrade, `pingInterval 15000`, `pingTimeout 45000`,
`maxPayload 8388608`, `connectTimeout 20000`, CORS `*` with credentials, EIO≠4 → 400
`{"code":5,"message":"Unsupported protocol version"}`. Only the default namespace.
Engine.IO 6.6 and Socket.IO 4.8 server semantics are reimplemented in `engine.rs`
(transports, upgrade, heartbeat, JSONP polling, compression, raw handshake aborts),
`socket.rs` (parser), `sio.rs` (namespace/socket lifecycle) and `handlers.rs`/`rpc.rs`.
Covered by `compat/phase2.mjs` and a socket.io-client 4.8 run (websocket-only and
polling→upgrade). EIO3 and other namespaces are refused exactly as the TS server does.

- [x] Engine.IO handshake (`0{sid,upgrades,pingInterval,pingTimeout,maxPayload}`), heartbeat, close
- [x] Polling transport + websocket upgrade (`2probe`/`3probe`/`5`, `6` noop)
- [x] Socket.IO CONNECT with `auth`; `40{"sid"}`; middleware failure → `44{"message"}`
- [x] Auth middleware errors: `Missing authentication token`, `Session ID required for session-scoped clients`,
      `Machine ID required for machine-scoped clients`, `Invalid authentication token`
- [x] Rooms: `user:U`, `user:U:user-scoped`, `user:U:session:S`, `user:U:machine:M`, `rpc:U:<method>`
- [x] Machine-scoped connect/disconnect → `machine-activity` ephemeral (user-scoped only)
- [x] `app-state` (+ `auth.appState` initial) for push suppression; `x-happy-client` / `auth.happyClient` labels
- [x] Event acks, binary placeholders, client acks for server emits

### Client → server events
- [x] `ping` (ack `{}`)
- [x] `rpc-register` / `rpc-unregister` → `rpc-registered` / `rpc-unregistered` / `rpc-error`
- [x] `rpc-call` (ack) — room lookup, 15 s reconnect grace (200 ms polls), self-call check,
      30 s ack timeout (`operation has timed out`), 2 s presence poll / 2 misses (`RPC target disconnected`)
- [x] `update-metadata` (ack), `update-state` (ack)
- [x] `session-alive` (activity cache, 30 s threshold, 5 s batched flush, stop suppression)
- [x] `message` (per-socket FIFO lock; seq allocated even for duplicates; skip sender)
- [x] `session-end`
- [x] `session-subscribe` / `session-unsubscribe` (ack; machine-scoped only; shared FIFO lock)
- [x] `machine-alive`, `machine-update-metadata` (ack), `machine-update-state` (ack)
- [x] `usage-report` (ack; per-socket FIFO lock)
- [x] `artifact-read`, `artifact-update`, `artifact-create`, `artifact-delete` (ack)
- [x] `access-key-get` (ack)

### Server → client
- [x] `update` payload `{id, seq, body:{t,...}, createdAt}` from ported code: `new-message`, `new-session`,
      `update-session`, `delete-session`, `update-account`, `update-machine`, `new-artifact`,
      `update-artifact`, `delete-artifact`
- [ ] the same from Phase 3 routes: `new-machine`, `delete-machine`, HTTP artifact routes, `new-feed-post`,
      `kv-batch-update`, `new-project`, `update-project`, `delete-project`
- [x] `ephemeral`: `activity`, `machine-activity`, `usage`, `session-event`
- [x] `rpc-request` (with ack), `rpc-registered`, `rpc-unregistered`, `rpc-error`
- [x] Recipient filters: all-user, user-scoped-only, all-interested-in-session, machine-scoped-only; skip-sender

## Background jobs
- [x] Session/machine timeout sweep (10 min inactivity, every 60 s)
- [x] Activity cache flush (5 s) + cleanup (5 min)
- [x] DB record-count gauges (60 s)

## Environment variables

| Variable | TS use | Rust |
|---|---|---|
| `DATABASE_URL` | Postgres (Prisma) | [x] (Prisma-only URL params stripped) |
| `HANDY_MASTER_SECRET` | tokens, KeyTree, ElevenLabs user id | [x] |
| `PORT` | API port (3005) | [x] |
| `HOST` | bind host (standalone only; `main.ts` binds 0.0.0.0) | [x] (default 0.0.0.0) |
| `METRICS_ENABLED`, `METRICS_PORT` | metrics server | [ ] |
| `NODE_ENV` | log level | [ ] |
| `DATA_DIR` | local files root (`./data`) | [x] |
| `PUBLIC_URL` | public file / upload URLs | [ ] |
| `S3_HOST`, `S3_PORT`, `S3_USE_SSL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `S3_PUBLIC_URL` | Minio client | [ ] |
| `REDIS_URL` | adapter (multi-replica) | ignored (single process by design) |
| `DB_PROVIDER`, `PGLITE_DIR` | PGlite standalone | not ported: backend-only (external Postgres only) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URL` | OAuth | [ ] |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_REDIRECT_URI`, `GITHUB_WEBHOOK_SECRET` | webhooks enabled iff all set | [ ] |
| `ELEVENLABS_API_KEY` | voice | [ ] |
| `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING` | dev log route + `.logs/` file | [ ] |
| `HAPPY_STATIC_DIR`, `HAPPY_INJECT_HTML_CONFIG` | self-host webapp | not ported: backend-only |
| new: `HAPPY_WORKERS` | — | [x] tokio worker threads (default: allowed CPUs, cgroup `cpu.max` aware) |
| new: `DATABASE_POOL_SIZE` | — | [x] sqlx pool size (default: `connection_limit` URL param, else 4 × workers clamped to 10..200) |
| new: `HAPPY_LOG` | — | [x] tracing filter (default `info,sqlx=warn`) |

## Dead code in the TS server (not ported)
`buildRelationshipUpdatedEvent`, `buildMachineStatusEphemeral`, `usernameUpdate`,
`storage/repeatKey.ts`, `storage/simpleCache.ts`, the `GlobalLock` table — defined but never called.
