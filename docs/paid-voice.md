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
│   ├─ GET /v1/convai/conversations?agent_id=X&user_id=Y&created_after=<30d>&page_size=100
│   │   └─ Sum call_duration_secs → usedSeconds (~108ms)
│   │
│   ├─ conversations == 100?          → { allowed: false, reason: "voice_conversation_limit_reached" }
│   ├─ usedSeconds >= 5h?             → { allowed: false, reason: "voice_hard_limit_reached" }
│   ├─ usedSeconds >= 20min + no sub? → { allowed: false, reason: "subscription_required" }
│   │
│   ├─ GET /v1/convai/conversation/token?agent_id=X&participant_name=ELEVEN_USER_ID
│   │   └─ Decode JWT → extract conv_id from video.room
│   │
│   └─ Return { conversationToken, conversationId, agentId, elevenUserId, usedSeconds, limitSeconds }
│
├─ allowed: false?
│   ├─ "voice_conversation_limit_reached" → alert (file issue on GitHub)
│   └─ other → paywall flow="voice_must_pay"
│
└─ allowed: true
    ├─ Free tier + first time on device? → soft paywall flow="voice_trial_eligible"
    └─ startSession({ conversationToken }) → WebRTC via LiveKit
```

## Limits

| Tier | Limit | Window | Cost to us | What happens |
|------|-------|--------|------------|--------------|
| Free | 20 min | 30 days | ~$0.19 | Paywall |
| Subscribed | 5 hours | 30 days | — | Hard block → BYO agent |
| BYO Agent | Unlimited | — | $0 | User's own ElevenLabs |
| Any | 100 conversations | 30 days | — | Hard block → file issue |

Cost: ~$0.01/min ($1600 / 171K min measured).

## Tracking

ElevenLabs is the source of truth. No local DB.

- `participant_name` on token mint → sets `user_id` on conversation record
- Usage: `GET /conversations?user_id=Y&created_after=<30d>&page_size=100` → sum durations
- `user_id` = HMAC-SHA256 of Happy user ID (deterministic, one-way)
- Max page_size is 100 → at 100 conversations we block (can't track more without pagination)

**TODO:** Remove `VoiceConversation` model from Prisma schema (no longer used, DB table can be dropped).

## Paywall Flows (RevenueCat)

Single paywall template, rules driven by custom variable `flow`:

| Flow | When | Behavior |
|------|------|----------|
| `voice_trial_eligible` | First voice use, free tier | Soft — dismissable, voice starts anyway |
| `voice_must_pay` | Server returns `allowed: false` | Hard — must purchase |
| `voluntary_support` | Settings | User-initiated |

### Future: Voice Agent Self-Sell

Have the agent mention pricing naturally. Inject `usedSeconds`/`limitSeconds` into context, add `showUpgradePaywall` client tool.

## Security

- JWT signed by ElevenLabs, single-use, can't be forged
- Agent set to "authorized only" — needs server-minted token
- Agent ID in public repo is harmless
