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
│   ├─ RevenueCat: load customer active entitlements; load subscriptions only when active
│   │   ├─ subscription → quota starts at current_period_starts_at
│   │   ├─ lifetime/non-subscription entitlement → paid rolling 30-day quota
│   │   └─ free → quota starts 30 days ago
│   │
│   ├─ GET /v1/convai/conversations?user_id=Y&call_start_after_unix=<quota-start-minus-max-call>&page_size=100
│   │   └─ Page through bounded lookback; sum only duration overlap with the quota window
│   │
│   ├─ conversations == 100?          → { allowed: false, reason: "voice_conversation_limit_reached" }
│   ├─ usedSeconds >= 5h?             → { allowed: false, reason: "voice_hard_limit_reached" }
│   ├─ usedSeconds >= 20min + no sub? → { allowed: false, reason: "subscription_required" }
│   │
│   ├─ GET /v1/convai/conversation/token?agent_id=X&participant_name=ELEVEN_USER_ID
│   │   └─ Use conversation_id from the response (legacy JWT fallback remains)
│   │
│   └─ Return { conversationToken, conversationId, agentId, elevenUserId, usedSeconds, limitSeconds }
│
├─ allowed: false?
│   ├─ "voice_conversation_limit_reached" → alert (file issue on GitHub)
│   └─ other → paywall flow="voice_must_pay"
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
| Free | 20 min | Rolling 30 days | ~$0.19 | Paywall |
| Subscribed | 5 hours | Current RevenueCat billing period | — | Hard block → BYO agent |
| Lifetime/non-subscription entitlement | 5 hours | Rolling 30 days | — | Hard block → BYO agent |
| BYO Agent | Unlimited | — | $0 | User's own ElevenLabs |
| Any | 100 conversations | Same window as the user's tier | — | Hard block → file issue |

Cost: ~$0.01/min ($1600 / 171K min measured).

## Tracking

ElevenLabs is the source of truth. No local DB.

- `participant_name` on token mint → sets `user_id` on conversation record
- Usage: query from `<quota-start> - VOICE_MAX_CONVERSATION_DURATION_SECONDS`, paginate up to the bounded server limit, and sum only the portion of each call after `<quota-start>`. This charges calls that cross a quota boundary without scanning unbounded history.
- Paid quota start: matching access-granting RevenueCat subscription's `current_period_starts_at`
- Lifetime/non-subscription active entitlement and free quota start: 30 days before the request
- `user_id` = HMAC-SHA256 of Happy user ID (deterministic, one-way)
- Only conversations that start inside the quota window count toward the 100-conversation limit. Calls started before the boundary can contribute overlap duration but do not consume the new-window count.
- Max page_size is 100; the server paginates a bounded number of pages and fails closed if it cannot establish the count.

Set `VOICE_MAX_CONVERSATION_DURATION_SECONDS` to at least the ElevenLabs
agent's `max_duration_seconds` setting. It defaults to 18,000 seconds and is
capped at 86,400 seconds to keep the usage query bounded.

The RevenueCat service key must allow both customer and subscription reads.
Active paid subscription/lifetime status is cached briefly per user to avoid
repeated RevenueCat reads; a subscription cache entry never outlives its current
billing-period end. Inactive status is deliberately not cached so an immediate
retry after purchase refreshes access. If subscription data is
unavailable, users below the rolling free limit can still start voice; paid
access above that limit fails with a retryable service error instead of reusing
an incorrect billing window.

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
