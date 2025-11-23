# Self-Hosted Happy Setup Guide

This guide explains how to use your fork of Happy with self-hosted server infrastructure.

## Quick Start

### 1. CLI Configuration

The CLI already supports self-hosted setups via environment variables:

```bash
# Add to ~/.bashrc or ~/.zshrc
export HAPPY_HOME_DIR=~/.happy-dev          # Where to store credentials/logs
export HAPPY_SERVER_URL=http://localhost:3005   # Your server URL
export HAPPY_WEBAPP_URL=http://localhost:8081   # Your web client URL
```

**Important**: You need BOTH `HAPPY_SERVER_URL` and `HAPPY_WEBAPP_URL`!

### 2. Web Client Configuration

The web client auto-detects localhost and already has a settings UI!

**Auto-detection** (for localhost):
- When you run the web client on `localhost:8081`
- It automatically uses `http://localhost:3005` as the server
- No configuration needed for development!

**Manual configuration**:
1. Navigate to Settings → Server Configuration (or `/server` route)
2. Enter your custom server URL
3. Click "Save"
4. Restart the app

**Environment variable**:
```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005 yarn web
```

### 3. Mobile App Configuration

Same as web client above - the settings page works on mobile too!

## Hardcoded URLs - What Needs Changing

### ✅ Already Configurable

1. **CLI server URL** - via `HAPPY_SERVER_URL`
2. **CLI webapp URL** - via `HAPPY_WEBAPP_URL`
3. **Web/Mobile server URL** - via settings UI or `EXPO_PUBLIC_HAPPY_SERVER_URL`

### ⚠️ Requires Code Changes

#### 1. **Server OAuth Redirects** (optional - only if you want GitHub OAuth)
**File**: `/happy-server/sources/app/api/routes/connectRoutes.ts`
**Lines**: 102, 110, 135, 151, 159, 163

All GitHub OAuth redirects hardcoded to `https://app.happy.engineering`

**Solution** (if needed):
- Add `HAPPY_WEBAPP_URL` env var to server
- Replace all occurrences with the env var

#### 2. **Privacy Policy Link** (cosmetic)
**File**: `/happy/sources/components/SettingsView.tsx:445`

```typescript
const url = 'https://happy.engineering/privacy/';
```

**Solution**: Either update to your domain or remove the link

#### 3. **Documentation Links** (cosmetic)
- `src/ui/doctor.ts:265` - `https://happy.engineering/`
- `src/claude/utils/systemPrompt.ts:20` - `https://happy.engineering`

**Solution**: Update to your documentation URL or leave as-is

#### 4. **Mobile App Deep Links** (only needed for production builds)
**File**: `/happy/app.config.js:39, 65`

```javascript
associatedDomains: ["applinks:app.happy.engineering"]
```

**Solution**: Update to your domain when building for production

## Authentication Flow

### Development (Automated - Current Setup)

The `e2e-web-demo.sh` script uses **automated test credentials**:
1. Creates test account via `/scripts/setup-test-credentials.ts`
2. Bypasses normal QR code flow
3. Perfect for development/testing

### Production (Real Users)

For real usage, users go through the normal flow:

1. **CLI**: Run `happy auth`
   - Generates QR code
   - **Now prints correct localhost URL!** (with `HAPPY_WEBAPP_URL` set)

2. **Web/Mobile**: Scan QR code or click link
   - Approves authentication
   - Redirects back with credentials

## Modifying e2e-web-demo.sh for Production

The current script is optimized for **automated testing**. For real usage:

### Option A: Keep Test Credentials (Development)
No changes needed! Current flow is perfect for development.

### Option B: Real Authentication Flow (Production-like)

Create a new script `real-web-demo.sh`:

```bash
#!/bin/bash
set -e

echo "=== Happy Real Authentication Demo ==="

# Step 1: Start services
./happy-demo.sh start

# Step 2: Start web client
echo "Starting web client..."
cd happy
EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005 yarn web &
WEB_PID=$!
cd ..

# Step 3: Start daemon (will use HAPPY_WEBAPP_URL for auth)
echo "Starting daemon..."
export HAPPY_HOME_DIR=~/.happy-dev
export HAPPY_SERVER_URL=http://localhost:3005
export HAPPY_WEBAPP_URL=http://localhost:8081

./happy-cli/bin/happy.mjs daemon start

# Step 4: Run auth command
echo ""
echo "Run this command to authenticate:"
echo "  HAPPY_HOME_DIR=~/.happy-dev HAPPY_SERVER_URL=http://localhost:3005 HAPPY_WEBAPP_URL=http://localhost:8081 ./happy-cli/bin/happy.mjs auth"
echo ""
echo "Then scan the QR code or click the link in your web browser!"
echo ""

# Cleanup on exit
trap "kill $WEB_PID 2>/dev/null; exit" INT TERM EXIT
wait
```

## Mobile App - Xcode Build

### Development Builds (Expo Go)
No Xcode needed! Just run:
```bash
yarn ios  # or yarn android
```

### Production Builds
You'll need to:

1. **Update app.config.js**:
   - Change `associatedDomains` if using deep links
   - Update `bundleIdentifier` and `package` to your own

2. **Run prebuild**:
   ```bash
   yarn prebuild
   ```

3. **Open in Xcode**:
   ```bash
   open ios/happy.xcworkspace
   ```

4. **Configure**:
   - Set your Apple Developer account
   - Update bundle identifier
   - Update provisioning profiles

## Complete Example

### ~/.bashrc / ~/.zshrc
```bash
# Happy CLI configuration
export HAPPY_HOME_DIR=~/.happy-dev
export HAPPY_SERVER_URL=http://localhost:3005
export HAPPY_WEBAPP_URL=http://localhost:8081

# Convenience alias
alias happy='HAPPY_HOME_DIR=$HAPPY_HOME_DIR HAPPY_SERVER_URL=$HAPPY_SERVER_URL HAPPY_WEBAPP_URL=$HAPPY_WEBAPP_URL ./happy-cli/bin/happy.mjs'
```

### Test it works
```bash
source ~/.bashrc  # or ~/.zshrc

# Should now show localhost URL!
happy auth
```

## Summary of Changes Needed

### Immediate (For Real Usage)
- ✅ Set `HAPPY_WEBAPP_URL` environment variable
- ✅ Web client already auto-detects localhost
- ✅ Settings UI already exists for custom servers

### Optional (Nice to Have)
- Update server OAuth redirects (if using GitHub integration)
- Update documentation links
- Update privacy policy link
- Update mobile deep links (for production builds only)

### Not Needed
- ❌ No CLI code changes needed
- ❌ No web/mobile code changes needed for basic self-hosting
- ❌ No database migrations needed
- ❌ No build process changes for development

## Testing the Complete Flow

1. **Start services**:
   ```bash
   ./happy-demo.sh start
   ```

2. **Start web client** (in separate terminal):
   ```bash
   cd happy
   yarn web
   ```

3. **Set environment** (in separate terminal):
   ```bash
   export HAPPY_HOME_DIR=~/.happy-dev
   export HAPPY_SERVER_URL=http://localhost:3005
   export HAPPY_WEBAPP_URL=http://localhost:8081
   ```

4. **Authenticate**:
   ```bash
   ./happy-cli/bin/happy.mjs auth
   ```

5. **Open browser to localhost:8081** and click the authentication link or scan QR!

The auth URL will now correctly show `http://localhost:8081/terminal/connect#key=...` instead of `https://app.happy.engineering/...`!
