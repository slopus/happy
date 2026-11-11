# Quirks of the TS server, reproduced on purpose

Every item here is odd behavior of `packages/happy-server` that the Rust server
reproduces. Do not fix them without changing both servers.

## HTTP layer

1. **Validation runs before authentication.** Fastify validates params → body →
   querystring before the `authenticate` preHandler, so an unauthenticated request
   with a bad body gets 400, not 401. Only the first failing part is reported.
2. **Validation error body** is `{"error":"Error","message":"body/publicKey Invalid input:
   expected string, received undefined, body/challenge ...","statusCode":400}`; the
   path for the root is `body/` (trailing slash, then a space).
3. **Global JSON parser override.** `connectRoutes` registers its own
   `application/json` parser for the whole app: an empty body becomes `{}` for
   POST/PUT/PATCH and `undefined` for DELETE/GET. Invalid JSON returns
   `{"error":"SyntaxError","message":<V8 JSON.parse message>,"statusCode":400}`.
4. `text/plain` bodies are accepted (string body → schema error); unknown content
   types are 415 `{"error":"FastifyError","message":"Unsupported Media Type: <type>"}`.
5. **No 405.** An unknown method on a known path is the generic 404
   `{"error":"Not found","path":"<url with query>","method":"<METHOD>"}`.
6. Uncaught handler errors (bad base64 in `/v1/auth`, unknown feed cursor,
   `DELETE /v1/connect/:vendor` with nothing to delete) are 500
   `{"error":"Internal Server Error","message":"An unexpected error occurred","statusCode":500}`.
7. Routes with a zod response schema strip unknown keys and emit keys in schema
   order (`/v1/feed` hides `userId`, `counter`, `updatedAt`).
8. `/v1/updates` without a trailing slash is not Engine.IO; it falls through to the
   Fastify 404 handler.
9. **Bad URLs bypass every hook.** A path that `decodeURI` rejects (`%zz`, a
    truncated escape, overlong UTF-8 such as `%C0%80`, anywhere before `?`) is answered
    by find-my-way's `onBadUrl`: 400
    `{"error":"Bad Request","code":"FST_ERR_BAD_URL","message":"'<url incl. query>' is not a valid url component","statusCode":400}`
    with `content-type: application/json` (no charset) and **no CORS header**.
10. **Route params follow find-my-way.** A param longer than 100 UTF-16 units makes
    the whole lookup miss (generic 404 even though the route exists); an empty
    param matches (`GET /v1/sessions//messages` → "Session not found",
    `DELETE /v1/sessions/` reaches the handler with `sessionId = ""`). Escapes are
    decoded with `decodeURI` and then only the reserved characters (`%2F` → `/`,
    `%25` → `%`, …) inside params.
11. An `OPTIONS` request without `Origin` + `Access-Control-Request-Method` is 400
    `Invalid Preflight Request` with `content-type: text/plain` (no charset).
12. **Response schema failures cascade.** A handler payload that fails its status
    schema becomes a 500 through the custom error handler; if that 500 payload fails
    the route's 500 schema too, Fastify's fallback answers
    `{"statusCode":500,"code":"FST_ERR_FAILED_ERROR_SERIALIZATION","message":"Failed to serialize an error. Error: Response doesn't match the schema. Original error: Response doesn't match the schema"}`.
    Error-handler payloads (validation 400s, 401s from `authenticate`) also pass
    through the route's schema for their status code.
13. Request JSON objects get JS property order: integer-like keys
    (`"0"`, `"17"`, not `"01"`) move to the front in ascending order, everywhere a
    body or a jsonb value passes through a JS object.

## Data and timestamps

14. Every Prisma `update`/`updateMany`/`upsert` sets `updatedAt` to the JS clock
   (millisecond precision). Allocating a user seq therefore bumps
   `Account.updatedAt`, and allocating a session seq bumps `Session.updatedAt`,
   which reorders `GET /v1/sessions` (ordered by `updatedAt desc`).
15. `createdAt`/`updatedAt` on insert are client-side JS timestamps, one `Date` per
    statement: all rows of one `createManyAndReturn` share a timestamp.
16. Message `content` read back from Postgres has jsonb key order (`{"c":…,"t":"encrypted"}`),
    while the realtime `new-message` update carries the in-memory order
    (`{"t":"encrypted","c":…}`).
17. Public keys are stored as **uppercase** hex (`@stablelib/hex`).
18. `POST /v1/sessions` accepts `agentState` in its schema but never stores it.
19. `GET /v2/sessions`: `cursor=cursor_v1_` (empty id) is ignored rather than
    rejected; `limit`/`changedSince` use `||` defaults, so `changedSince=0` means "no
    filter"; a `changedSince` beyond the JS date range (±8.64e15 ms) is a 500.
20. Prisma validates `Int` filters as INT4: `GET /v3/.../messages?after_seq=3000000000`
    passes zod (safe integer) and then fails in Prisma → 500.
21. `POST /v1/usage/query` buckets by the **server's local time zone** (`new Date(y, m, d, h)`),
    sums with `(acc || 0) + v` (floating point, `0.30000000000000004`), and fails the
    whole query with 500 `{"error":"Failed to query usage reports"}` as soon as one
    report's `data.tokens` or `data.cost` is missing or null. `startTime=0` or a
    missing `groupBy` falls back through `||`.
22. `POST /v1/auth/request`: a pending request is never updated; the
    `supportsV2` of the first request wins.
23. Base64 decoding uses two different decoders: `privacy-kit` (`@stablelib/base64`,
    throws on bad characters or on inputs shorter than 4 chars) and Node's
    `Buffer.from(x, 'base64')` (lenient, also accepts base64url) for session/machine
    data keys and KV creates.

## Sockets

24. The socket `message` handler allocates a user seq **and** a session seq before
    checking `localId` dedup, so duplicates burn both sequence numbers (session
    `seq` gaps).
25. RPC forwarding returns the daemon's first ack argument (`RemoteSocket` uses
    `expectSingleResponse`), not an array.
26. An `rpc-call` for a method nobody registered waits the full 15 s reconnect grace
    window before answering `RPC method not available`.

(Continued as more are found.)

## Known deviations

Differences accepted on purpose. Everything else is a bug.

1. **V8 `JSON.parse` error wording.** The Rust parser reproduces V8's messages and
   positions for every case in `testdata/json_errors.json` (and the harness); rarer
   inputs may word an error differently.
2. **Thumbhash of resized avatars.** The TS server resizes with sharp (libvips)
   before computing the thumbhash; the Rust server uses the `image` crate. Hashes of
   the same picture can differ slightly.
3. **`/metrics` has no Prisma metrics.** The `prisma_*` series do not exist; the
   application metrics keep their names, labels and buckets.
4. **Ed25519 non-canonical signatures.** tweetnacl and ed25519-dalek disagree on
   signatures with a non-reduced `S` scalar; such signatures are rejected by Rust.
   Real clients never produce them.
5. **JS infinities in JSON.** `serde_json` cannot hold ±Infinity, so a request
   number that overflows (`1e400`) is carried as ±1.7976931348623157e308 and treated
   as infinite. The one literal `1.7976931348623157e308` is therefore also read as
   Infinity.
6. **Lone UTF-16 surrogates** in request JSON strings (`"\ud83d"`) become U+FFFD,
   since Rust strings are UTF-8.
7. **`GET /files/*` framing.** The TS server streams the file (chunked); the Rust
   server sends it with `content-length`. Same status, headers otherwise and bytes.
8. **Failures after commit.** `sessionDelete` runs its after-commit work without
   awaiting it; if allocating the `delete-session` seq fails, the TS process dies on
   an unhandled rejection. The Rust server logs the error and keeps running.
9. **User seqs for `POST /v3/.../messages`.** The TS server allocates one user seq
   per created message (one `UPDATE` each); the Rust server takes the same
   consecutive range in one `UPDATE`. The values match (single writer); `Account.updatedAt`
   is bumped once instead of once per message. This assumes the TS server is never
   live on the same database at the same time: switching servers is stop one, then
   start the other. The advisory lock only keeps a second *Rust* instance out.

