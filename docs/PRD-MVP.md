# Runline MVP PRD

**Goal:** Deploy Runline to Sean's phone for dogfooding with Emila.

## Current State

### Done ✅

| Item | Status | Notes |
|------|--------|-------|
| Fork Happy → Runline-AI/arc | ✅ | github.com/Runline-AI/arc |
| Create `sources/arc/agent/` | ✅ | Types, context, hooks |
| `.arc.yaml` schema | ✅ | Zod + YAML parser |
| AgentConfigProvider | ✅ | Added to app layout |
| Auto-wire apiSocket RPC | ✅ | Provider auto-connects |
| Documentation | ✅ | README, ARCHITECTURE, AGENTS, SETUP |
| Emila `.arc.yaml` | ✅ | In emila repo |
| App icon | ✅ | Runline icon copied |
| App name | ✅ | "Runline" in app.config.js |
| Bundle ID | ✅ | com.runline.arc.* |
| URL scheme | ✅ | runline:// |
| Complete branding | ✅ | All Happy→Runline, translations done |
| Custom RunlineLogo SVG | ✅ | Wordmark component |
| Custom RunlineIcon SVG | ✅ | "R" icon component |
| Tab reordering | ✅ | Runners, Inbox, Settings |
| Terminology update | ✅ | Terminals→Runners |
| GitHub URLs | ✅ | runline-ai/arc |
| Translation key renames | ✅ | happySessionId→runlineSessionId, etc. |
| CLI rebrand | ✅ | happy→arc command, @runline-ai/arc on GitHub Packages |
| Upstream merge | ✅ | Merged upstream Happy changes (libsodium 0.8.2, zh-Hant, etc.) |

### In Progress 🔄

| Item | Status | Notes |
|------|--------|-------|
| EAS build setup | ✅ | projectId: `cdbf75d0-33e5-4874-a238-e8c65281c100`, owner: `runline` |
| iOS build | ✅ | Build succeeded, ready for TestFlight submit |
| Android build | ❌ | Build failed - debug later (iOS is priority for MVP) |
| TestFlight deploy | ⏳ | Run `eas submit --platform ios` |

### Remaining ❌

| Item | Priority | Notes |
|------|----------|-------|
| Hook up display name | P1 | Patch session list |
| Hook up avatar | P2 | Custom avatar from .arc.yaml |
| Voice binding | P2 | Per-session ElevenLabs |
| Privacy Policy URL | P1 | Still points to happy.engineering |

---

## Next Steps for Deploy

### 1. Submit iOS to TestFlight

iOS build succeeded. Submit it:

```bash
cd ~/src/runline/arc/expo-app
eas submit --platform ios
```

### 2. Debug Android Build (Later)

Android build failed. Not blocking MVP - iOS is the priority.

```bash
# Check build logs
eas build:list --platform android --status errored --limit 1

# Retry when ready
eas build --platform android --profile development
```

---

## CLI Installation (Done)

Arc CLI is published to GitHub Packages as `@runline-ai/arc`.

```bash
# Configure npm for GitHub Packages
echo "@runline-ai:registry=https://npm.pkg.github.com" >> ~/.npmrc
gh auth refresh -h github.com -s read:packages
echo "//npm.pkg.github.com/:_authToken=$(gh auth token)" >> ~/.npmrc

# Install globally
npm install -g @runline-ai/arc

# Migrate credentials from Happy (one-time)
cp ~/.happy/access.key ~/.arc/
cp ~/.happy/settings.json ~/.arc/

# Verify
arc --help
```

**Confirmed working:** Sessions started with `arc` CLI appear in Happy mobile app (same relay server).

---

## Testing Checklist

### Before Deploy
- [x] App builds without errors (iOS EAS build succeeded)
- [x] Icon displays correctly (verified matches runline-context branding)
- [x] Arc CLI connects to relay and appears in Happy mobile app

### After Deploy
- [ ] Install via TestFlight
- [ ] Login (new account or existing Happy account)
- [ ] Pair with computer running `arc` CLI
- [ ] See sessions in list
- [ ] Open Emila session
- [ ] Send message, receive response
- [ ] Check logs for .arc.yaml RPC attempt

---

## P1 Tasks (Post-Deploy)

### Agent Display Name
- Patch session list component to use `getDisplayName()`
- Show "Emila" instead of path-based name
- Add loading shimmer while fetching config

### Agent Avatar
- Support custom avatar URL from .arc.yaml
- Fall back to generated avatar if not specified

---

## P2 Tasks (Future)

### Voice Integration
- Read `elevenlabs_agent_id` from .arc.yaml
- Initialize ElevenLabs with session-specific agent
- Test voice conversations with Emila

---

## Known Issues / Risks

1. **Relay Infrastructure (Intentional)**
   - Arc CLI and Runline app use Happy's relay server (`api.cluster-fluster.com`)
   - Same account works on both Happy and Runline apps
   - This is intentional for MVP - avoids managing infrastructure
   - Sessions started with `arc` CLI appear in Happy mobile app too
   - Future: Deploy own relay when needed for security/features (see ROADMAP.md)

2. **Code signing**
   - Need Apple Developer account
   - EAS handles provisioning automatically

3. **Bundle ID**
   - Using `com.runline.arc` to avoid conflicts with Happy

---

## Success Criteria

MVP is complete when:
1. ✅ App rebranded (icon, name, bundle ID)
2. ✅ Complete UI branding (logo, translations, terminology)
3. ⏳ Runline installed on Sean's iPhone via TestFlight
4. ⏳ Can connect to Emila running on laptop
5. ⏳ Can send/receive messages
6. Bonus: Shows "Emila" as session name (P1)
