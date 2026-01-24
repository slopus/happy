# Arc MVP PRD

**Goal:** Deploy Arc to Sean's phone for dogfooding with Emila.

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
| App name | ✅ | "Arc" in app.config.js |
| Bundle ID | ✅ | com.runline.arc.* |
| URL scheme | ✅ | arc:// |

### Remaining ❌

| Item | Priority | Notes |
|------|----------|-------|
| EAS build setup | P0 | Run `eas build:configure` |
| TestFlight deploy | P0 | Build and upload |
| Hook up display name | P1 | Patch session list |
| Hook up avatar | P2 | Custom avatar from .arc.yaml |
| Voice binding | P2 | Per-session ElevenLabs |

---

## Next Steps for Deploy

### 1. EAS Build Setup

```bash
cd ~/src/runline/arc/expo-app

# Install EAS CLI (if not installed)
npm install -g eas-cli

# Login to Expo account
eas login

# Configure EAS for this project (creates new project)
eas build:configure

# This will:
# - Create/update eas.json
# - Generate a new project ID
# - You'll need to update app.config.js with the new projectId
```

### 2. Update app.config.js

After running `eas build:configure`, uncomment and update:

```javascript
extra: {
    eas: {
        projectId: "YOUR_NEW_PROJECT_ID"  // From EAS
    }
},
owner: "your-expo-username"  // Your Expo account
```

### 3. Build for TestFlight

```bash
# Build iOS preview (for TestFlight)
eas build --platform ios --profile preview

# Or build for simulator first to test
eas build --platform ios --profile development --local
```

### 4. Submit to TestFlight

```bash
# After build completes
eas submit --platform ios
```

---

## Testing Checklist

### Before Deploy
- [ ] App builds without errors locally
- [ ] Icon displays correctly in simulator
- [ ] Can connect to relay in dev mode

### After Deploy
- [ ] Install via TestFlight
- [ ] Login (new account or existing Happy account)
- [ ] Pair with computer running `happy` CLI
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

1. **Relay compatibility**
   - Arc uses Happy's relay (no changes needed)
   - Same account works on both apps

2. **Code signing**
   - Need Apple Developer account
   - EAS handles provisioning automatically

3. **Bundle ID**
   - Using `com.runline.arc` to avoid conflicts with Happy

---

## Success Criteria

MVP is complete when:
1. ✅ App rebranded (icon, name, bundle ID)
2. ⏳ Arc installed on Sean's iPhone via TestFlight
3. ⏳ Can connect to Emila running on laptop
4. ⏳ Can send/receive messages
5. Bonus: Shows "Emila" as session name (P1)
