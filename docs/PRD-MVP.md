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

### Not Started ❌

| Item | Priority | Notes |
|------|----------|-------|
| App icon/branding | P0 | Use runline_icon.png |
| App name change | P0 | "Arc" instead of "Happy" |
| Bundle ID change | P0 | com.runline.arc |
| Hook up display name | P1 | Patch session list to use agent config |
| Hook up avatar | P2 | Use custom avatar from .arc.yaml |
| Voice binding | P2 | Per-session ElevenLabs agent |
| TestFlight build | P0 | Expo EAS for deployment |

---

## MVP Scope

### P0 — Required for First Deploy

1. **App Branding**
   - [ ] Replace app icon with `runline_icon.png`
   - [ ] Change app name to "Arc"
   - [ ] Update bundle ID to `com.runline.arc`
   - [ ] Update splash screen (optional, can use default)

2. **EAS Build Setup**
   - [ ] Create `eas.json` for Expo Application Services
   - [ ] Configure iOS provisioning/signing
   - [ ] Build for TestFlight
   - [ ] Deploy to Sean's device

3. **Basic Functionality Test**
   - [ ] Connect to Happy relay
   - [ ] See Emila session in list
   - [ ] Send/receive messages
   - [ ] Verify RPC works (check console for .arc.yaml load attempt)

### P1 — Display Customization

4. **Agent Display Name**
   - [ ] Patch session list component to call `getDisplayName()`
   - [ ] Show "Emila" instead of path-based name
   - [ ] Show loading shimmer while fetching

5. **Agent Avatar**
   - [ ] Support custom avatar URL from .arc.yaml
   - [ ] Fall back to generated avatar

### P2 — Voice Integration

6. **Per-Session Voice**
   - [ ] Read `elevenlabs_agent_id` from .arc.yaml
   - [ ] Initialize ElevenLabs with session-specific agent
   - [ ] Test voice with Emila

---

## Files to Modify for P0

### 1. App Icon
```
Source: /Users/sean/src/runline/runline-context/company/runline_icon.png
Target: expo-app/assets/images/icon.png (and adaptive variants)
```

### 2. app.json
```json
{
  "expo": {
    "name": "Arc",
    "slug": "arc",
    "ios": {
      "bundleIdentifier": "com.runline.arc"
    },
    "android": {
      "package": "com.runline.arc"
    }
  }
}
```

### 3. EAS Configuration
```bash
# Install EAS CLI
npm install -g eas-cli

# Login
eas login

# Configure
eas build:configure

# Build for iOS
eas build --platform ios --profile preview
```

---

## Testing Checklist

### Before Deploy
- [ ] App builds without errors
- [ ] Icon displays correctly in simulator
- [ ] Can connect to relay in dev mode

### After Deploy
- [ ] Install via TestFlight
- [ ] Login with existing Happy account (or create new)
- [ ] Pair with computer running `happy` CLI
- [ ] See sessions in list
- [ ] Open Emila session
- [ ] Send message, receive response
- [ ] Check console/logs for .arc.yaml RPC attempt

---

## Known Issues / Risks

1. **Happy account compatibility**
   - Arc uses same relay as Happy
   - Existing Happy users should work
   - May need separate account for clean testing

2. **Code signing**
   - Need Apple Developer account
   - Need to set up provisioning profiles
   - EAS can handle this if configured

3. **Bundle ID conflict**
   - If Happy is installed, need different bundle ID
   - Using `com.runline.arc` to avoid conflicts

---

## Success Criteria

MVP is complete when:
1. Arc is installed on Sean's iPhone via TestFlight
2. Can connect to Emila running on laptop
3. Can send/receive messages
4. App shows "Arc" branding (icon, name)
5. Bonus: Shows "Emila" as session name (P1)
