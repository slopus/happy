# ElevenLabs Voice Usage Gating

## Problem

We want to require a subscription after a user has consumed 1 hour of ElevenLabs conversation time.

For the first version, the constraints are:

- no local usage DB
- no post-call webhook ingestion
- no mid-call cutoff
- first page of ElevenLabs conversation history is acceptable

That means the gate runs only when a new voice session starts. If a user crosses the threshold during an active call, that call continues and the block applies on the next session start.

## Current Repo State

The current `main` implementation does not reliably gate voice usage:

- With `experiments=false`, the app starts ElevenLabs directly with `agentId` and bypasses billing/auth entirely.
- With `experiments=true`, the app calls `/v1/voice/token`, but the app no longer sends `revenueCatPublicKey`.
- The server still expects `revenueCatPublicKey` in production.
- The client treats `400` from `/v1/voice/token` as `allowed:true`, which bypasses the paywall path.

Relevant files:

- Server token route: `packages/happy-server/sources/app/api/routes/voiceRoutes.ts`
- Client token fetch: `packages/happy-app/sources/sync/apiVoice.ts`
- Voice start decision: `packages/happy-app/sources/realtime/RealtimeSession.ts`
- ElevenLabs client session start:
  - `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx`
  - `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx`

## Existing Secret Assumptions

The repo already assumes ElevenLabs API access exists on the server:

- `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` reads `process.env.ELEVENLABS_API_KEY`.
- `packages/happy-server/deploy/handy.yaml` extracts `/handy-elevenlabs`.
- `docs/deployment.md` documents `ELEVENLABS_API_KEY` as required for `/v1/voice/token` in production.

The app does not currently have an ElevenLabs API secret. Client config only carries public values such as RevenueCat public keys and ElevenLabs agent IDs.

## Decision

Implement a stateless-at-runtime preflight check that uses ElevenLabs as the system of record:

1. Derive a stable pseudonymous ElevenLabs `user_id` from the Happy user ID.
2. Before issuing a conversation token, query ElevenLabs conversation history for that `user_id`.
3. Read only the first page.
4. Sum `call_duration_secs` across the returned conversations.
5. If cumulative duration is below 3600 seconds, allow voice.
6. If cumulative duration is 3600 seconds or above, require an active subscription.
7. If allowed, mint and return an ElevenLabs conversation token.
8. Start the ElevenLabs session using the same stable `user_id`.

Use a stable pseudonymous ID, not a random nonce. Recommended shape:

`elevenUserId = "u_" + base64url(HMAC_SHA256(APP_SECRET, happyUserId))`

This keeps the join key stable across sessions without exposing the raw Happy account ID to ElevenLabs.

## External APIs

As of 2026-03-24, the relevant ElevenLabs APIs are:

- SDK session start supports passing `userId`
  - https://elevenlabs.io/docs/conversational-ai/libraries/react
- Low-level personalization payload supports `user_id`
  - https://elevenlabs.io/docs/eleven-agents/customization/personalization
- Conversation history can be listed with `user_id`, and responses include `call_duration_secs`
  - https://elevenlabs.io/docs/eleven-agents/api-reference/conversations/list
- ElevenLabs API authentication uses `xi-api-key`
  - https://elevenlabs.io/docs/api-reference/authentication

No new ElevenLabs credential is needed beyond the existing server-side `ELEVENLABS_API_KEY`.

## Proposed Control Flow

```text
User taps mic
  |
  v
startRealtimeSession(sessionId, initialContext)
  |
  +--> request microphone permission
  |
  +--> load JWT credentials
  |
  +--> determine agentId from app config
  |
  v
POST /v1/voice/token
  Authorization: Bearer <jwt>
  body: { sessionId, agentId }
  |
  v
Server authenticates JWT
  |
  +--> request.userId = Happy account id
  |
  +--> derive stable elevenUserId from request.userId
  |
  +--> load ELEVENLABS_API_KEY from env
  |
  +--> GET /v1/convai/conversations?user_id=<elevenUserId>&page_size=100&summary_mode=exclude
  |      header: xi-api-key: ELEVENLABS_API_KEY
  |
  +--> sum conversations[*].call_duration_secs on first page only
  |
  +--> totalSeconds < 3600 ?
  |      |
  |      +--> yes: allow
  |      |
  |      +--> no:
  |             check subscription entitlement
  |               |
  |               +--> active subscription: allow
  |               |
  |               +--> no subscription:
  |                      return {
  |                        allowed: false,
  |                        reason: "voice_limit_reached",
  |                        usedSeconds: totalSeconds,
  |                        limitSeconds: 3600
  |                      }
  |
  +--> if allowed:
         GET /v1/convai/conversation/token?agent_id=<agentId>
           header: xi-api-key: ELEVENLABS_API_KEY
         return {
           allowed: true,
           token,
           agentId,
           elevenUserId,
           usedSeconds: totalSeconds
         }
  |
  v
Client receives response
  |
  +--> allowed = false
  |      |
  |      +--> present paywall
  |      +--> if purchased/restored: sync purchases and retry
  |      +--> if cancelled: do not start voice
  |
  +--> allowed = true
         |
         +--> start ElevenLabs session with:
                - conversationToken
                - userId = elevenUserId
                - dynamicVariables.sessionId
                - dynamicVariables.initialConversationContext
  |
  v
ElevenLabs records the conversation under user_id = elevenUserId
  |
  v
Next mic tap repeats the same preflight check
```

## Important Limitations

- First page only is not exact lifetime accounting. It is only the sum of the returned page.
- If ElevenLabs has more matching conversations than the first page, this can undercount.
- If ElevenLabs changes or does not document the exact sort order of the list endpoint, relying on the first page is inherently approximate.
- Because the gate runs only at session start, users can exceed 1 hour during an active conversation.
- No local state means no reconciliation, no idempotency, and no protection against concurrent starts beyond what ElevenLabs history already reflects.

## Required Code Changes

### Server

Update `packages/happy-server/sources/app/api/routes/voiceRoutes.ts` to:

- derive and return `elevenUserId`
- query ElevenLabs conversation history before minting a token
- sum `call_duration_secs`
- return structured denial when the user is over the free threshold and unsubscribed
- stop relying on client-supplied `revenueCatPublicKey`
- perform subscription verification server-side if paywall remains part of the product

Preferred response shape:

```ts
type VoiceTokenResponse =
  | {
      allowed: true;
      token: string;
      agentId: string;
      elevenUserId: string;
      usedSeconds: number;
      limitSeconds: number;
    }
  | {
      allowed: false;
      reason: 'voice_limit_reached' | 'subscription_required';
      usedSeconds: number;
      limitSeconds: number;
      agentId: string;
    };
```

### Client

Update:

- `packages/happy-app/sources/realtime/types.ts`
- `packages/happy-app/sources/realtime/RealtimeVoiceSession.tsx`
- `packages/happy-app/sources/realtime/RealtimeVoiceSession.web.tsx`
- `packages/happy-app/sources/realtime/RealtimeSession.ts`
- `packages/happy-app/sources/sync/apiVoice.ts`

Changes needed:

- add `userId?: string` to `VoiceSessionConfig`
- pass `userId` into `conversationInstance.startSession(...)`
- remove the `400 => allowed:true` fallback
- remove or redesign the `experiments=false` bypass if voice gating should apply to all users
- retry the token request after successful purchase

## Subscription Check

If the product still wants a paywall after the free threshold, the subscription check should be server-side.

Current `main` is mismatched:

- the server expects `revenueCatPublicKey` from the client
- the client no longer sends it
- the deployment already extracts `/handy-revenuecat`

Preferred fix:

- use a server-side RevenueCat credential or another trusted subscription source
- keep RevenueCat public keys only for rendering the client paywall
- treat the client purchase result as a hint, then verify entitlement on the server before issuing a token

## Testing

### Server tests

Add route tests for:

- no prior ElevenLabs conversations
- first page total below threshold
- first page total exactly at threshold
- first page total above threshold with no subscription
- first page total above threshold with active subscription
- missing `ELEVENLABS_API_KEY`
- ElevenLabs history API failure
- ElevenLabs token API failure

### Client tests

Add tests for:

- allowed response with token
- denied response presents paywall
- successful purchase retries the request
- cancelled purchase does not start voice
- `userId` is threaded into `startSession(...)`
- voice gating still happens when experimental settings are disabled, if that is the desired product behavior

### Manual verification

1. Run against a production-like server with `ELEVENLABS_API_KEY` configured.
2. Use a stable test account so the derived `elevenUserId` is consistent across runs.
3. Seed the account with enough ElevenLabs conversation duration to land below and above 3600 seconds.
4. Verify:
   - below threshold: voice starts
   - above threshold + no subscription: paywall appears and voice does not start
   - above threshold + active subscription: voice starts
5. Confirm ElevenLabs sessions are created with the expected `user_id`.

## Prior Art

There is older server-only free-trial work in the legacy `slopus/happy-server` repository on branch:

- `charge-for-voice-after-3-trail-conversations`

That branch tracked free trials using database counters, not ElevenLabs duration history. It is useful as prior art for gating shape and server-side entitlement checks, but it does not implement the 1-hour cumulative duration design described here.
