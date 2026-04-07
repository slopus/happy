# Paid Voice — Rate Limiting & Auth

How we gate, track, and limit voice conversations powered by ElevenLabs.

## Flow

```
User taps mic
│
├─ Bypass mode? (custom agent ID set)
│   └─ yes → connect directly to ElevenLabs with agentId, skip everything below
│
├─ POST /v1/voice/conversations { agentId }   ←── requires Happy JWT
│   │
│   ├─ ELEVENLABS_API_KEY missing?     → 500
│   ├─ REVENUECAT_API_KEY missing?     → 500
│   │
│   ├─ Query DB: VoiceConversation where accountId + last 30 days
│   │   └─ Lazily fetch call_duration_secs from ElevenLabs
│   │   └─ Persist only terminal conversations (status: done/failed)
│   │   └─ Sum persisted + in-memory active durations → usedSeconds
│   │
│   ├─ usedSeconds >= 5h?             → { allowed: false, reason: "voice_hard_limit_reached" }
│   ├─ usedSeconds >= 1h + no sub?    → { allowed: false, reason: "subscription_required" }
│   │
│   ├─ GET /get-signed-url?agent_id=X&include_conversation_id=true
│   │   └─ Returns { signed_url: "wss://...&conversation_signature=SIG&conversation_id=CONV" }
│   │
│   ├─ Extract conversation_id from URL
│   ├─ INSERT VoiceConversation { accountId, conversationId }
│   │
│   └─ Return { allowed: true, signedUrl, agentId, elevenUserId, usedSeconds, limitSeconds }
│
├─ allowed: false?
│   ├─ "subscription_required"        → show paywall (RevenueCat)
│   ├─ "voice_hard_limit_reached"     → show "configure your own agent" message
│   └─ purchased? → retry POST /v1/voice/conversations
│
└─ allowed: true
    └─ startSession({ signedUrl, connectionType: 'webrtc' })
        └─ ElevenLabs creates conversation with THAT conversation_id
```

## Limits

| Tier | Limit | Window | What happens |
|------|-------|--------|--------------|
| Free | 1 hour | 30 days rolling | Paywall → RevenueCat subscription |
| Subscribed | 5 hours | 30 days rolling | Hard block → "use your own ElevenLabs agent" |
| BYO Agent | Unlimited | — | Bypass mode, user's own ElevenLabs quota |

## How Tracking Works

```
Token issuance (server):
  GET /get-signed-url?include_conversation_id=true
  → signed_url contains conversation_id (e.g. conv_7701knk7rzf8fbqvctgmkc79bb4h)
  → INSERT VoiceConversation { accountId, conversationId, durationSecs: null }

Next token request:
  → SELECT VoiceConversation WHERE accountId = ? AND createdAt > 30 days ago
  → For each row where durationSecs IS NULL:
      GET /v1/convai/conversations/{conversationId}
      → status + metadata.call_duration_secs
      → status in {done, failed}? UPDATE durationSecs = call_duration_secs
      → otherwise keep duration in memory only for this request
  → SUM(persisted durations + in-memory active durations) → usedSeconds
```

We own the mapping. ElevenLabs can't tell us which user a conversation belongs to (authorized agents override user_id to the API key owner). But we know because we created the signed URL and recorded the conversation_id before the client ever connected.

## Security Properties

```
Signed URL with include_conversation_id=true:
  ✅ conversation_id baked into conversation_signature
  ✅ Can't swap conversation_id — signature check fails
  ✅ Can't fake a conversation_id — rejected by ElevenLabs
  ✅ Single-use — second connection rejected
  ✅ Agent set to "authorized only" — can't connect without signed URL
  ✅ Agent ID in public repo — harmless, needs server-minted signed URL
```

## ElevenLabs Agent Config

```
Agent: agent_6701k211syvvegba4kt7m68nxjmw (production)
       agent_7801k2c0r5hjfraa1kdbytpvs6yt (dev/preview)

Dashboard settings:
  auth.enable_auth: true                    ← "authorized only"
  max_duration_seconds: 3600                ← 1hr max per conversation
  call_limits.daily_limit: 10000
```

---

## Appendix: Why Other Approaches Failed

### A. ElevenLabs user_id tracking

ElevenLabs has a `user_id` field on conversations. On **public** agents, passing `user_id` in the client SDK's `startSession()` or in the token mint request tags the conversation. You can then query `GET /conversations?user_id=X` to get per-user usage.

**Breaks on authorized agents.** When `enable_auth: true`, ElevenLabs overrides `user_id` to the API key owner's account ID for every conversation. Passing `user_id` at token mint time, in the client initiation message, or via `participant_name` — all ignored. Every conversation shows the same `user_id` regardless of who actually connected.

### B. Webhooks

ElevenLabs has a `conversation_initiation_client_data_webhook` — supposed to fire when a conversation starts, allowing the server to inject metadata (including `user_id`).

**Doesn't fire for SDK connections.** Only triggers for Twilio/SIP inbound phone calls. WebSocket and WebRTC connections from the SDK never hit it. Tested: configured webhook URL on the agent, started conversations via SDK — webhook never received a request.

General workspace webhooks only support three events: `transcript`, `audio`, `call_initiation_failure`. No `conversation_started` or `conversation_created` event exists.

### C. Token-based conversation ID matching

The conversation token JWT contains a pre-allocated `conv_id` in its `name` field. Plan was to extract it at mint time and map it to the user.

**ElevenLabs creates a different conversation_id at connection time.** The `conv_id` in the JWT does not match the actual `conversation_id` returned by `conversation_initiation_metadata_event`. Mapping breaks.

### D. What actually works: `include_conversation_id=true`

The `get-signed-url` endpoint accepts `include_conversation_id=true`. This returns a signed URL with the `conversation_id` baked into both the URL params and the cryptographic signature. The conversation_id in the URL **matches** the actual conversation_id at connection time. The signature is bound to it — can't be swapped, faked, or reused.

This is the only reliable way to know the conversation_id before the client connects.
