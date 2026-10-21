# Paid Voice — Rate Limiting & Auth

## Flow

```
User taps mic
│
├─ Bypass mode? (custom agent ID)
│   └─ connect directly to ElevenLabs, skip everything
│
├─ POST /v1/voice/conversations { agentId }
│   │
│   ├─ GET /v1/convai/conversations?user_id=Y&call_start_after_unix=<30d ago, Unix seconds>&page_size=100
│   │   └─ Follow next_cursor while has_more, sum call_duration_secs → usedSeconds
│   │
│   ├─ usedSeconds >= 5h?             → { allowed: false, reason: "voice_hard_limit_reached" }
│   ├─ usedSeconds >= 20min + no sub? → { allowed: false, reason: "subscription_required" }
│   │
│   ├─ GET /v1/convai/conversation/token?agent_id=X&participant_name=ELEVEN_USER_ID
│   │   └─ Decode JWT → extract conv_id from video.room
│   │
│   └─ Return { conversationToken, conversationId, agentId, elevenUserId, usedSeconds, limitSeconds }
│
├─ allowed: false?
│   └─ paywall flow="voice_must_pay"
│
└─ allowed: true
    ├─ feature flag voice-upsell == "show-paywall-before-first-voice-chat"?
    │   └─ first free voice start only → soft paywall flow="voice_trial_eligible"
    ├─ feature flag voice-upsell == "voice-onboarding-and-upsell"?
    │   └─ inject onboarding + upsell guidance into voice prompt
    └─ otherwise
        └─ control → no soft paywall and no onboarding experiment
        then startSession({ conversationToken }) → WebRTC via LiveKit
```

## Limits

| Tier | Limit | Window | Cost to us | What happens |
|------|-------|--------|------------|--------------|
| Free | 20 min | 30 days | ~$0.19 | Paywall |
| Subscribed | 5 hours | 30 days | — | Hard block → BYO agent |
| BYO Agent | Unlimited | — | $0 | User's own ElevenLabs |

Cost: ~$0.01/min ($1600 / 171K min measured).

## Tracking

ElevenLabs is the source of truth. No local DB.

- `participant_name` on token mint → sets `user_id` on conversation record
- Usage: `GET /conversations?user_id=Y&call_start_after_unix=<30d ago, Unix seconds>&page_size=100` → sum durations
- `user_id` = HMAC-SHA256 of Happy user ID (deterministic, one-way)
- Max `page_size` is 100. Follow `next_cursor` while `has_more` to count all matching conversations, including users with more than 100 calls.
- Stop reading once the 5-hour duration quota is reached. Above that quota, reported duration and conversation count are lower bounds on monthly usage.
- History lookup has a 15-second total timeout. Provider failures and malformed/repeated cursors return a server error; they never grant voice based on partial or zero usage.
- `/v1/voice/usage` retains numeric `conversationLimit: 100` for compatibility with shipped native clients. It is a deprecated display field, no longer an eligibility limit. Older settings screens may display `103 / 100`; new calls are governed by duration and subscription status.

**TODO:** Remove `VoiceConversation` model from Prisma schema (no longer used, DB table can be dropped).

## Paywall Flows (RevenueCat)

Single paywall template, rules driven by custom variable `flow`:

| Flow | When | Behavior |
|------|------|----------|
| `voice_trial_eligible` | Feature flag variant `show-paywall-before-first-voice-chat`, first free voice use | Soft — dismissable, voice starts anyway |
| `voice_must_pay` | Server returns `allowed: false` | Hard — must purchase |
| `voluntary_support` | Settings | User-initiated |

### Future: Voice Agent Self-Sell

Have the agent mention pricing naturally. Inject `usedSeconds`/`limitSeconds` into context, add `showUpgradePaywall` client tool.

## Security

- JWT signed by ElevenLabs, single-use, can't be forged
- Agent set to "authorized only" — needs server-minted token
- Agent ID in public repo is harmless
