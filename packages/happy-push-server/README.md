# happy-push-server

A Cloudflare Worker that replaces the Expo push service for Happy. Apps
register their push token and get back a stable `HappyPushToken[<id>]`
token, the way `getExpoPushTokenAsync` returns `ExponentPushToken[…]`.
happy-server stores that token and sends to it through this Worker's send
endpoint.

The token an app registers can be native (an APNs device token or an FCM
registration token), which this Worker delivers directly, or an Expo push
token, which it forwards to Expo. That lets every device move to
`HappyPushToken[…]` wrappers now, including app builds that only have an
Expo token, and switch to native delivery later without the wrapper
changing.

The send API is its own contract, not a copy of Expo's. It keeps two things
from Expo on purpose: the per-recipient ticket list and the
`DeviceNotRegistered` error code, because happy-server's token cleanup relies
on both.

- Runtime: Cloudflare Workers, using D1 for storage, Hono for routing, and zod for validation.
- No Node dependencies. Signing uses Web Crypto: ES256 for APNs and RS256 for the FCM service account.
- No receipts API. APNs and FCM accept or reject each message within the same HTTP exchange, so their tickets are final when returned. Expo-forwarded tickets are not; see [Providers](#providers).

## API

Base URL: `https://push.cluster-fluster.com` (a Workers Custom Domain, set in `wrangler.jsonc`).

No endpoint needs credentials. Registration works like Expo's: the random `deviceId` identifies the install. Sending also works like Expo's default: the unguessable `HappyPushToken[…]` (about 131 random bits) is the capability. That means any Happy server, including self-hosted ones, can use the shared push server without credentials. Rate limits bound the abuse; see [Rate limits](#rate-limits).

All request errors use one envelope: `{ "errors": [{ "code", "message", "details"? }] }`.

### `POST /v1/devices/register` (public, called by the app)

```jsonc
{
    "deviceId": "e621e1f8-c36c-495a-93fc-0c247a3e6e5f", // 8-128 chars [A-Za-z0-9._:-], lowercased
    "appId": "com.ex3ndr.happy",                         // bundle id / Android package; also the APNs topic
    "platform": "ios",                                   // "ios" (any APNs client: iOS, iPadOS, macOS) | "android"
    "provider": "apns",                                  // optional: "apns" | "fcm" | "expo"; defaults to apns for ios, fcm for android
    "pushToken": "<APNs hex | FCM registration token | ExponentPushToken[…]>",
    "environment": "production",                         // apns only: "production" | "development" (APNs sandbox). Default production.
    "metadata": {                                        // optional; every field optional, ≤128 chars
        "deviceName": "…", "deviceModel": "…", "osName": "…", "osVersion": "…",
        "appVersion": "…", "appBuild": "…", "locale": "…", "timezone": "…"
    }
}
```

The response is `200 { "token": "HappyPushToken[3MTQ1KZhQAh5CdD4rY7xRX]" }`. The id is 22 base62 characters, about 131 random bits.

`pushToken` was first called `nativeToken`; requests that still send `nativeToken` are accepted. `provider` must match the platform for native tokens (`apns` on ios, `fcm` on android). An Expo token is accepted on either platform and must look like `ExponentPushToken[…]` or `ExpoPushToken[…]` (at most 256 characters).

- **Stable.** The token is keyed on `(appId, deviceId)`. A rotated push token, a switch between Expo and native delivery (either way), new metadata, or a re-registration after unregister all update the same row and return the same `HappyPushToken[…]` token. If `metadata` is omitted, the stored metadata is kept.
- **No double delivery.** A push token can be live on only one install, per provider. If it is registered under a new `deviceId`, for example after a reinstall that generated a fresh id, the old install is marked inactive with `inactive_reason = 'superseded'`. The old `HappyPushToken[…]` token then answers `DeviceNotRegistered`, so happy-server's existing cleanup deletes it. A partial unique index enforces this rule in the database too.
- APNs tokens are lowercased. `environment` is ignored, and stored as `production`, for `fcm` and `expo`.
- `ALLOWED_APP_IDS` restricts which `appId`s may register (403 `APP_NOT_ALLOWED`). The default in `wrangler.jsonc` lists the mobile app ids (`com.ex3ndr.happy`, `com.slopus.happy.preview`, `com.slopus.happy.dev`) and the native macOS app ids (`com.slopus.happy.native.mac`, `.preview`, `.dev`, from the HappyMac target in `packages/happy-ios/project.yml`).
- **macOS registers as `ios`.** APNs for a macOS app works the same way: same hosts, same token auth, the topic is the app's bundle id, and the payload format is the same. The difference is on the client: the HappyMac entitlements currently have no `com.apple.developer.aps-environment`, and the app does not call `NSApplication.registerForRemoteNotifications()` yet.
- **Trust model.** The trust model is the same as Expo's. The device holds no secret, so the random `deviceId` acts as the credential: anyone who knows an install's `deviceId` and `appId` can re-point its `HappyPushToken[…]` token. Clients must use a random UUID and keep it private. Register and unregister are rate limited per client IP.

### Providers

| `provider` | Token | Delivered by | Credentials needed here | Ticket is final? |
|---|---|---|---|---|
| `apns` | APNs device token (hex) | APNs HTTP/2, directly | `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` | yes |
| `fcm` | FCM registration token | FCM HTTP v1, directly | `FCM_SERVICE_ACCOUNT` | yes |
| `expo` | `ExponentPushToken[…]` / `ExpoPushToken[…]` | Forwarded to `https://exp.host/--/api/v2/push/send` | none (no Expo access token is sent) | no |

**Expo forwarding.**
- Expo installs in one send request go to Expo as batches of up to 100 messages, one batch per app id: Expo rejects a batch that mixes tokens from different Expo projects. Each batch is one subrequest, and it shares the native sends' 6-connection budget and 6.5 s deadline. Tickets come back in request order whatever the mix of providers.
- Message fields map onto Expo's: `title`, `subtitle`, `body`, `data`, `sound`, `badge`, `channelId`, `categoryId`, `ttl`, `mutableContent`, `interruptionLevel`, the resolved `priority`, and `contentAvailable` → `_contentAvailable`. `threadId` has no Expo equivalent and is dropped.
- An `ok` ticket carries Expo's own ticket id. An Expo `DeviceNotRegistered` ticket deactivates the install, as long as it still holds that token. Other Expo error codes come back unchanged with `details.provider: 'expo'`. An HTTP or network failure fails that batch's tickets without deactivating anything; Expo's 429 maps to `MessageRateExceeded`.
- **Known limitation: no receipts.** Expo queues messages and reports the final outcome, including some `DeviceNotRegistered` cases, only through its receipts API. This Worker doesn't poll receipts. happy-server didn't either, so cleanup is no worse than today, but a dead Expo token is caught only when Expo rejects it at send time.
- The per-recipient rate limit applies to Expo installs the same way. A raw `ExponentPushToken[…]` sent straight to `/v1/push/send` is still answered `DeviceNotRegistered`: only `HappyPushToken[…]` wrappers are accepted.

### `POST /v1/devices/unregister` (public)

`{ "deviceId", "appId" }` → `200 { "ok": true }`, including for unknown installs. This marks the install inactive. Its `HappyPushToken[…]` id stays reserved, so re-registering returns the same token.

### `POST /v1/push/send` (public, called by happy-server, self-hosted servers, and happy-cli)

No auth header is needed. The body is one message or an array of messages, with at most 100 recipients in total once `to` arrays are expanded. A larger request gets 400 `PUSH_TOO_MANY_NOTIFICATIONS`. Messages are validated strictly: an unknown field fails the whole request with 400 `VALIDATION_ERROR` instead of being silently dropped. That includes Expo's `priority: 'default'`, `expiration`, and `_contentAvailable`.

```jsonc
{
    "to": "HappyPushToken[3MTQ1KZhQAh5CdD4rY7xRX]", // or an array of tokens
    "title": "It's ready!",
    "body": "Claude finished",
    "data": { "sessionId": "sess_1" },
    "sound": "default",
    "channelId": "messages",
    "priority": "high",                              // optional; see below
    "ttl": 3600                                      // optional; seconds
}
```

| Field | APNs | FCM (data-only message) |
|---|---|---|
| `to` | `HappyPushToken[…]`, or an array of them | same |
| `title` / `subtitle` / `body` | `aps.alert.{title,subtitle,body}` | `data.title` / `data.subtitle` / `data.message` |
| `data` | top-level `body` key (object) | `data.body` (JSON string) |
| `sound` | `aps.sound` (no sound when `null` or omitted) | `data.sound`, except `'default'`, which is omitted so the default sound plays |
| `badge` | `aps.badge` | `data.badge` |
| `channelId` | — | `data.channelId` |
| `categoryId` | `aps.category` | `data.categoryId` |
| `threadId` | `aps.thread-id` | — |
| `mutableContent` | `aps.mutable-content: 1` | — |
| `interruptionLevel` | `aps.interruption-level` | — |
| `contentAvailable` | `aps.content-available: 1` (wake the app for a visible alert too) | — |
| `priority` | `high` → `apns-priority: 10`, `normal` → `5` | `high` → `android.priority: HIGH`, `normal` → `NORMAL` |
| `ttl` | `apns-expiration` = now + ttl (`0` → `0`: try once, don't store) | `android.ttl` = `"<ttl>s"` |

**Priority.** `priority` is `'high' | 'normal'`:

- When it is omitted, a message with a title, subtitle, or body is sent `high`, and a data-only message is sent `normal`.
- High priority means immediate delivery. On Android it also means a dozing device is woken.
- FCM deprioritizes apps whose high-priority messages don't show a notification, so send data-only pushes at `normal` unless they really need to arrive at once.

**Background pushes.** On iOS, a message with no title, subtitle, or body is sent as a background push: `apns-push-type: background` and `content-available: 1`. Apple requires priority 5 for background pushes, so they always go out at 5, even when the message asks for `high`.

**Size limit.** Payloads over 4096 bytes return `MessageTooBig` without calling the provider.

**Where `data` goes.** It uses the layout Expo's push service uses, because that is the layout expo-notifications parses. I checked this against expo-notifications 55.0.13 in `node_modules`:

- **iOS.** `request.content.data` is `userInfo["body"]` for remote notifications (`ios/ExpoNotifications/Notifications/NotificationRecords.swift`, `serializedNotificationData`).
- **Android.** `FirebaseMessagingDelegate` builds the visible notification from data keys `title`, `message`, `channelId`, `sound`, `badge`, and others (`NotificationData.kt`). `NotificationSerializer.java` JSON-parses `data.body` into `request.content.data`. The message is data-only, so the app's handler receives it in the foreground and in the background.

Because of this, the app's tap routing, which reads `data.sessionId` in `notificationRouting.ts`, keeps working without changes.

**Response.** `200 { "data": Ticket[] }` has one ticket per recipient, in request order:

```jsonc
{ "status": "ok", "id": "<uuid>" }  // id is also sent as apns-id
{ "status": "error", "message": "…", "details": { "error": "DeviceNotRegistered", "provider": "apns", "reason": "Unregistered" } }
```

The ticket shape and the `details.error` names are borrowed from Expo, so happy-server's existing `DeviceNotRegistered` cleanup works unchanged:

| `details.error` | When | Install |
|---|---|---|
| `DeviceNotRegistered` | Unknown, malformed, or inactive `HappyPushToken[…]`; APNs 410 / `BadDeviceToken` / `Unregistered` / `ExpiredToken` / `DeviceTokenNotForTopic`; FCM `UNREGISTERED` / 404 / `INVALID_ARGUMENT` about the registration token; an Expo `DeviceNotRegistered` ticket | deactivated |
| `InvalidCredentials` | Provider credentials missing or bad, or rejected by APNs (403 `*ProviderToken`) or FCM (401/403, OAuth failure); the cached token is dropped. For `expo`, Expo's own `InvalidCredentials` (the Expo project lacks push credentials). | kept |
| `MessageTooBig` | Payload over 4 KB, APNs 413, or FCM "too big" | kept |
| `MessageRateExceeded` | Provider 429 / `QUOTA_EXCEEDED` / Expo `MessageRateExceeded`, or this recipient is over the per-token send limit (`reason: 'RecipientRateLimited'`; not sent) | kept |
| `MismatchSenderId` | FCM `SENDER_ID_MISMATCH` | kept |
| (absent) | Transient errors and other 4xx: 5xx, timeouts, network errors | kept |

Deactivation is guarded on the native token that was actually sent to. If the app re-registers a fresh token while a send is in flight, the fresh token is not deactivated.

**Timing.** Recipients are sent concurrently, at most 6 at a time, which is the Workers per-request connection limit. One 6.5 s deadline covers the whole request, inside happy-server's 8 s send budget. Each request signs one APNs JWT and fetches one FCM OAuth token at most. Across requests, the APNs JWT is cached per isolate for 50 minutes, because Apple rejects refreshes more often than every 20 minutes, and the FCM access token is cached until 5 minutes before Google's expiry (about 55 minutes). Only settled values are cached across requests, because sharing in-flight promises between requests is unsafe in Workers.

### Rate limits

Both limits use the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (`ratelimits` in `wrangler.jsonc`). Its counts are approximate and kept separately in each Cloudflare location, so they stop floods, not the occasional extra request.

| Binding | Key | Limit | Over the limit |
|---|---|---|---|
| `SEND_RATE_LIMITER` | recipient token (`send:<id>`) | 60 per 60 s | That recipient gets a `MessageRateExceeded` ticket and is not sent to. Other recipients in the same request are unaffected. |
| `REGISTER_RATE_LIMITER` | client IP (`cf-connecting-ip`) | 60 per 60 s, register and unregister combined | 429 `RATE_LIMITED`, checked before the body is read |

- **Send is limited per recipient, not per sender IP.** The hosted happy-server sends every user's pushes from a few IPs, so a per-IP limit would throttle everyone together. The abuse an open send endpoint invites is flooding one device, and a per-token key bounds exactly that. Unknown tokens are answered with `DeviceNotRegistered` from the database lookup and never reach the limiter.
- **Registration is limited per IP.** Apps register on launch and when the token rotates, so even a carrier-NAT IP shared by many phones stays far below 60 a minute.
- **Missing or failing limiter.** Both bindings are optional in code: if one is absent (tests, `wrangler dev` without it), the limit is not applied. If `limit()` throws, the request is allowed and the error is logged, so a limiter outage cannot stop delivery.
- **Subrequests.** Cloudflare's docs describe `limit()` as a check against a locally cached count, synced in the background, and don't list it as a subrequest. I could not find a statement either way, so budget up to 100 extra calls per 100-recipient send to be safe. On the Paid plan the default limit is 10,000 subrequests per invocation, so that leaves plenty of headroom.

### `GET /health`

`200 { "ok": true }`

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | `devices` table (`migrations/`, applied in order) |
| `APNS_KEY_ID` | secret | 10-character id of the `.p8` APNs auth key |
| `APNS_TEAM_ID` | secret | Apple team id |
| `APNS_PRIVATE_KEY` | secret | Contents of `AuthKey_<id>.p8`. Literal `\n` sequences are accepted. |
| `FCM_SERVICE_ACCOUNT` | secret | Firebase service-account JSON with permission to send FCM messages |
| `ALLOWED_APP_IDS` | var | Comma-separated list of allowed app ids. Empty allows any app. Set in `wrangler.jsonc`. |
| `SEND_RATE_LIMITER`, `REGISTER_RATE_LIMITER` | rate-limit bindings | See [Rate limits](#rate-limits). Optional in code. |

If a provider's credentials are missing, its recipients get `InvalidCredentials` tickets. The Worker keeps running and the other provider still delivers. One APNs key covers every bundle id in the team, and the sandbox or production host is chosen per install from `environment`.

## Setup and deploy

```sh
cd packages/happy-push-server
pnpm wrangler d1 create happy-push-server # once; the database_id is already in wrangler.jsonc
pnpm db:migrate:remote                    # wrangler d1 migrations apply happy-push-server --remote
pnpm wrangler secret put APNS_KEY_ID
pnpm wrangler secret put APNS_TEAM_ID
pnpm wrangler secret put APNS_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
pnpm wrangler secret put FCM_SERVICE_ACCOUNT < service-account.json
pnpm deploy                               # also attaches push.cluster-fluster.com
```

Deploys run from `main` matching `origin/main` with a clean tree, like every Happy release.

A 100-recipient send makes up to about 102 outbound subrequests: one per native recipient, one per Expo batch (up to 100 Expo installs of one app id), plus at most one FCM OAuth fetch. The Workers Free plan caps a request at 50 external subrequests, so this needs the Paid plan, or senders must keep batches under about 45.

## Development

```sh
cp .dev.vars.example .dev.vars   # fill in
pnpm db:migrate:local
pnpm dev                         # wrangler dev
pnpm typecheck
pnpm test
```

Local `wrangler dev` on macOS cannot reach APNs, because outbound HTTP/2 from local workerd does not work (workerd#4841). A deployed Worker can reach it. Use a deployed preview to test real iOS delivery.

Tests use vitest in Node, not `@cloudflare/vitest-pool-workers`. The agent sandbox this repo is developed in cannot bind local ports, and workerd needs them. `test/d1.ts` implements the subset of D1 the Worker uses on top of Node's built-in `node:sqlite` and applies the real migration files. Provider `fetch` is mocked, and the JWTs are verified against freshly generated keys.

## Integration plan (follow-ups, not in this package)

1. **happy-server** (`sources/app/push/pushSend.ts`)
   - Send `HappyPushToken[…]` tokens to `https://push.cluster-fluster.com/v1/push/send` (overridable with an env var); no auth header. Keep sending `ExponentPushToken[…]` tokens to Expo during the migration, splitting the batch by prefix and merging the tickets back in order.
   - The message happy-server builds today (`to`, `title`, `body`, `data`, `sound: 'default'`, `channelId`) is valid as it is and goes out at high priority. Set `priority` explicitly only to override that.
   - `pushDispatch.ts` needs no change. It already deletes tokens whose ticket has `details.error === 'DeviceNotRegistered'`.
   - `/v1/push-tokens` stores any string, so `HappyPushToken[…]` tokens register as they are.
2. **happy-app** (`sources/sync/pushRegistration.ts`)
   - **Can ship now, before native tokens:** keep `getExpoPushTokenAsync`, POST `{ deviceId, appId, platform, provider: "expo", pushToken: <ExponentPushToken[…]> }` to `https://push.cluster-fluster.com/v1/devices/register`, and register the returned `HappyPushToken[…]` with happy-server instead of the Expo token. Delivery still goes through Expo, so nothing about notifications changes for the user, but happy-server only ever sees wrappers from then on.
   - **Later, native:** replace `getExpoPushTokenAsync` with `getDevicePushTokenAsync()`, POST the result to `https://push.cluster-fluster.com/v1/devices/register`, and register the returned `HappyPushToken[…]` token with happy-server exactly as today. Keep unregistering the previous token when it changes, so Expo tokens are cleaned up.
   - Moving from Expo to native is just a re-registration with the same `deviceId` and `provider` omitted (or `apns`/`fcm`): the `HappyPushToken[…]` stays the same, so happy-server needs no update.
   - `deviceId`: a UUID persisted in secure storage. Reuse the Expo installation id (Keychain `EXDeviceInstallationUUIDKey`) so happy-app and happy-ios on the same install share one `HappyPushToken[…]` token.
   - `environment`: `development` for dev-client and debug iOS builds, which use the APNs sandbox.
   - Android needs `google-services.json` for the same Firebase project as `FCM_SERVICE_ACCOUNT`. Expo's FCM v1 setup already requires that.
   - Tap routing needs no change, because the payload layout matches Expo's.
3. **happy-ios** (`Sources/HappyCore/Push/ExpoPushTokenExchange.swift`)
   - This file already POSTs `{ deviceId, appId, development, deviceToken }` to Expo's `getExpoPushToken`. Add a sibling `PushTokenSource` that POSTs `{ deviceId, appId, platform: "ios", pushToken, environment }` here and reads `token`.
   - The native notification handler must read custom data from the payload's `body` key.
   - The macOS app (HappyMac) can register with the same call and `platform: "ios"`. First it needs `com.apple.developer.aps-environment` in `Mac/HappyMac.entitlements` and a call to `NSApplication.shared.registerForRemoteNotifications()`.
4. **happy-cli** (`src/api/pushNotifications.ts`)
   - Session-event pushes already go through happy-server's `/v1/sessions/:id/push-event`, so they work unchanged.
   - `sendToAllDevices`, used by `happy notify`, fetches the user's tokens and filters them with `Expo.isExpoPushToken`, which drops `HappyPushToken[…]` tokens. Because send needs no credentials, the fix is local: also accept the `HappyPushToken[` prefix and POST those tokens straight to `https://push.cluster-fluster.com/v1/push/send`, keeping Expo tokens on Expo during the migration.
5. **Self-hosted servers** (`happy server`, happy-server-self-host): they run the same `pushSend.ts`, so once happy-server sends `HappyPushToken[…]` tokens to the shared push server, self-hosted installs get native push with no credentials or configuration.
6. **Ops:** the D1 database, Worker, `push.cluster-fluster.com` custom domain, and APNs/FCM secrets are in place. Shipping Expo forwarding needs `pnpm db:migrate:remote` (applies `0002_expo_provider.sql`) before `pnpm deploy`, because the new code reads the `provider` and `push_token` columns. A dashboard of ticket error rates, from the Workers logs or an Analytics Engine binding, would cover what Expo's console showed.
