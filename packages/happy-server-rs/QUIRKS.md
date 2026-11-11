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

## Data and timestamps

9. Every Prisma `update`/`updateMany`/`upsert` sets `updatedAt` to the JS clock
   (millisecond precision). Allocating a user seq therefore bumps
   `Account.updatedAt`, and allocating a session seq bumps `Session.updatedAt`,
   which reorders `GET /v1/sessions` (ordered by `updatedAt desc`).
10. `createdAt`/`updatedAt` on insert are client-side JS timestamps, one `Date` per
    statement: all rows of one `createManyAndReturn` share a timestamp.
11. Message `content` read back from Postgres has jsonb key order (`{"c":…,"t":"encrypted"}`),
    while the realtime `new-message` update carries the in-memory order
    (`{"t":"encrypted","c":…}`).
12. Public keys are stored as **uppercase** hex (`@stablelib/hex`).
13. Base64 decoding uses two different decoders: `privacy-kit` (`@stablelib/base64`,
    throws on bad characters or on inputs shorter than 4 chars) and Node's
    `Buffer.from(x, 'base64')` (lenient, also accepts base64url) for session/machine
    data keys and KV creates.

## Sockets

14. The socket `message` handler allocates a user seq **and** a session seq before
    checking `localId` dedup, so duplicates burn both sequence numbers (session
    `seq` gaps).
15. RPC forwarding returns the daemon's first ack argument (`RemoteSocket` uses
    `expectSingleResponse`), not an array.
16. An `rpc-call` for a method nobody registered waits the full 15 s reconnect grace
    window before answering `RPC method not available`.

(Continued as more are found.)
