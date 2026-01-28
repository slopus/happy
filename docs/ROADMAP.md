# Runline Arc Roadmap

## Current State

Arc CLI and Runline mobile app are fully rebranded but use Happy's backend infrastructure:

| Component | Current | Future |
|-----------|---------|--------|
| CLI command | `arc` | `arc` |
| npm package | `@runline-ai/arc` | `@runline-ai/arc` |
| Relay server | `api.cluster-fluster.com` (Happy) | `api.runlineai.com` |
| Web app | `app.happy.engineering` | `app.runlineai.com` |
| Mobile app | Runline (TestFlight) | Runline (App Store) |

**Why use Happy's infrastructure for now:**
- Avoids managing relay server, database, auth system
- Faster time to dogfooding
- Can focus on Runner/agent features instead of ops
- Easy to switch later via env vars

---

## Phase 1: MVP (Current)

**Goal:** Dogfood Arc with Emila on Sean's phone

- [x] Fork Happy → Runline-AI/arc
- [x] Rebrand expo-app (Runline mobile)
- [x] Rebrand CLI (arc command)
- [x] Publish to GitHub Packages
- [ ] Deploy to TestFlight
- [ ] Connect to Emila runner

---

## Phase 2: Runner Features

**Goal:** Differentiate from Happy with Runner-specific features

- [ ] `.arc.yaml` display name in session list
- [ ] `.arc.yaml` custom avatar support
- [ ] `.arc.yaml` voice binding (ElevenLabs per-runner)
- [ ] Runner registry / discovery
- [ ] Organization-scoped runners

---

## Phase 3: Enterprise Features

**Goal:** Features for credit union deployments

- [ ] OTEL tracing (`arc --trace`)
- [ ] SSO / SAML authentication
- [ ] Audit logging
- [ ] Runner access controls
- [ ] CU-hosted deployment option

---

## Phase 4: Own Infrastructure

**Goal:** Full independence from Happy's backend

**When to do this:**
- When we need features Happy doesn't support
- When enterprise customers require data isolation
- When Happy's relay becomes a bottleneck
- When we want to monetize differently

**What's needed:**
1. **Relay Server** - Fork or reimplement `happy-server`
   - WebSocket relay for CLI ↔ mobile
   - Session discovery and management
   - Push notifications
   - User authentication

2. **Database** - PostgreSQL or similar
   - User accounts
   - Sessions
   - Machines
   - Encrypted message history

3. **Infrastructure** - Cloud deployment
   - API server (api.runlineai.com)
   - Web app (app.runlineai.com)
   - Database
   - Redis for pub/sub

4. **Migration** - Move users from Happy
   - Account migration path
   - Session history (optional)

**Switching is easy** - just set env vars:
```bash
export ARC_SERVER_URL=https://api.runlineai.com
export ARC_WEBAPP_URL=https://app.runlineai.com
```

---

## Not Planned

Things we're intentionally not building:

- **Desktop app** - CLI + mobile is enough
- **Windows native** - WSL works fine
- **Self-hosted mobile app** - Enterprise can use web
- **Electron wrapper** - Just use the CLI

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01-27 | Use Happy's relay for MVP | Faster to market, less ops |
| 2026-01-27 | CLI rebrand to `arc` | Clear differentiation for demos |
| 2026-01-27 | Publish to GitHub Packages | Private distribution for team |
