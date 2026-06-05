# User Identity Across Systems

How a single Happy user is identified across every external service.

## Primary ID: Happy Account CUID

- **Type:** CUID (collision-resistant unique ID, string)
- **Created:** On first auth via public-key signature verification (`Account.upsert` by `publicKey`)
- **Stored:** `Account.id` in Prisma, JWT payload (`{ user: CUID }`)
- **In code:** `request.userId` on server, `sync.serverID` on mobile
- **Visible in app:** Settings > Developer > Purchases page shows `sync.serverID`

## Identity Map

```
Happy Account CUID (e.g. cm4x7k2...)
│
├─► ElevenLabs ── u_{base64url(HMAC-SHA256(CUID, MASTER_SECRET))}
│                 Derived on every request, never stored.
│                 voiceRoutes.ts:deriveElevenUserId()
│
├─► RevenueCat ── Same CUID, passed directly as appUserID
│                 Set once on mobile: RevenueCat.configure({ appUserID: serverID })
│                 Server queries RevenueCat API with the same CUID
│
├─► GitHub ────── External GitHub integer ID → stored in Account.githubUserId
│                 Linked via OAuth in githubConnect.ts
│                 Also stores encrypted access token in GithubUser.token
│
└─► AI Vendors ── ServiceAccountToken { accountId: CUID, vendor, token }
   (OpenAI,       User's own API keys, encrypted at rest.
    Anthropic,    connectRoutes.ts: POST /v1/connect/:vendor/register
    Gemini)
```

## Auth Flow

```
Client keypair (libsodium/NaCl)
  │
  ├─ sign challenge with private key
  │
  ▼
POST /v1/auth { publicKey, challenge, signature }
  │
  ├─ server verifies signature (tweetnacl)
  ├─ Account.upsert({ where: { publicKey } })  →  CUID
  ├─ auth.createToken(CUID)  →  JWT (signed with HANDY_MASTER_SECRET)
  │
  ▼
Client stores JWT, sends as Authorization header on all requests
Server extracts CUID from JWT via app.authenticate decorator
```

## Key Design Decisions

| System | ID Type | Why |
|--------|---------|-----|
| ElevenLabs | HMAC-derived | Privacy — raw Happy ID never sent to ElevenLabs |
| RevenueCat | Pass-through | Direct correlation needed for subscription API calls |
| GitHub | Stored foreign key | Enables profile linking and account recovery via OAuth |
| AI vendors | Stored encrypted | User-owned keys, need to be retrievable |

## Local Scripting

To derive an ElevenLabs user ID from a Happy CUID locally:

```python
import hmac, hashlib, base64
digest = hmac.new(MASTER_SECRET.encode(), happy_cuid.encode(), hashlib.sha256).digest()
eleven_id = "u_" + base64.b64encode(digest).decode().replace("+","-").replace("/","_").rstrip("=")
```
