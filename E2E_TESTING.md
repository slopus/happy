# E2E Testing Guide for Self-Hosted Happy

This guide explains how to test the happy-server and happy-cli connection end-to-end in a headless environment.

## The Challenge

The happy-cli requires authentication via a mobile app or web browser. In a headless/remote environment, we can't easily use the iOS/Android apps or web browser.

## Solution: Automated Test Credentials

For headless e2e testing, we've created a script that automates the entire authentication flow without requiring manual interaction.

### Quick Start (Recommended for Headless Testing)

```bash
# 1. Start all services
./happy-launcher.sh start

# 2. Setup test credentials (automated, no interaction needed)
node scripts/setup-test-credentials.mjs

# 3. Run CLI with test credentials
HAPPY_HOME_DIR=/root/.happy-dev-test HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs auth status

# 4. Start daemon
HAPPY_HOME_DIR=/root/.happy-dev-test HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs daemon start

# 5. Test session creation
cd /tmp
HAPPY_HOME_DIR=/root/.happy-dev-test HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs --happy-starting-mode remote

# 6. List sessions
HAPPY_HOME_DIR=/root/.happy-dev-test HAPPY_SERVER_URL=http://localhost:3005 ./happy-cli/bin/happy.mjs daemon list

# 7. Run integration tests
cd happy-cli && yarn test:integration-test-env
```

The `setup-test-credentials.mjs` script automates the full authentication flow:
1. Creates a test account on the server (simulates mobile/web client)
2. Creates a CLI auth request (simulates CLI requesting auth)
3. Auto-approves the auth request (simulates user approving on mobile/web)
4. Fetches and saves credentials to `~/.happy-dev-test/`
5. Creates a machine ID for the test environment

**No browser or mobile app needed!**

## Alternative Solution: Use the Happy Web Client (for manual testing)

The `happy` directory contains an Expo React Native app that supports web deployment. We can run it locally and use it to authenticate and interact with the CLI.

## Step-by-Step E2E Test

### 1. Start the Services

```bash
./happy-launcher.sh start
```

This starts:
- PostgreSQL (port 5432)
- Redis (port 6379)
- MinIO (port 9000)
- happy-server (port 3005)

### 2. Install Happy Web Client Dependencies

```bash
cd happy
yarn install
```

### 3. Start the Web Client

```bash
cd happy
yarn start:local-server
```

This starts the Expo web client configured to connect to `http://localhost:3005` (your local server).

The command sets:
- `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005`
- `EXPO_PUBLIC_DEBUG=1`
- `PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=1`

### 4. Access the Web Client

The Expo dev server will display a URL like:
```
› Metro waiting on exp://192.168.x.x:8081
› Web is waiting on http://localhost:8081
```

Open `http://localhost:8081` in a text-based web browser (or any browser):

**Text-based browsers:**
- `lynx http://localhost:8081`
- `w3m http://localhost:8081`
- `links http://localhost:8081`

**Or use a regular browser** if available in your environment.

### 5. Run the CLI

In another terminal:

```bash
./happy-launcher.sh cli
```

Or directly:
```bash
cd happy-cli
HAPPY_HOME_DIR=~/.happy-dev HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs
```

The CLI will:
1. Generate an authentication QR code
2. Display it in the terminal
3. Wait for authentication from the web client

### 6. Authenticate

In the web client:
1. Navigate to the authentication screen
2. Scan/enter the authentication code from the CLI
3. Approve the authentication request

### 7. Test Session Creation

Once authenticated, the CLI should:
- Create a session with the server
- Allow remote control from the web client
- Show real-time updates

## Alternative: Programmatic Testing

For fully automated testing without a browser, check the integration test:

```bash
cd happy-cli
yarn test
```

The test file `src/daemon/daemon.integration.test.ts` shows how to:
- Start the daemon programmatically
- Create sessions via HTTP API
- Track session state
- Test server-CLI communication

Key endpoints used in tests:
- `/session-started` - Webhook for sessions to report themselves
- `/list` - List tracked sessions
- `/stop-session` - Terminate specific session
- `/spawn-session` - Create new session

## Troubleshooting

### Server not responding
```bash
./happy-launcher.sh status    # Check all services
./happy-launcher.sh logs server  # View server logs
```

### Authentication timeout
- Verify server URL in web client matches CLI config
- Check that both are using `http://localhost:3005`
- Ensure `.env` file exists in happy-server (run `./happy-launcher.sh start` to create it)

### Database connection errors
```bash
# Recreate database if needed
sudo -u postgres psql -c "DROP DATABASE IF EXISTS handy;"
sudo -u postgres psql -c "CREATE DATABASE handy;"
cd happy-server && yarn migrate
```

### Clean slate
```bash
./happy-launcher.sh cleanup --clean-logs  # Stop everything and clean logs
./happy-launcher.sh start                 # Fresh start
```

## Architecture

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────┐
│   Web Client    │ ◄────► │ happy-server │ ◄────► │ PostgreSQL  │
│ (localhost:8081)│         │ (port 3005)  │         │             │
└─────────────────┘         └──────────────┘         └─────────────┘
         ▲                         │
         │                         │
         │                    ┌────▼────┐
         │                    │  Redis  │
         │                    └─────────┘
         │                         │
         │                    ┌────▼────┐
         └────────────────────┤  MinIO  │
                              └─────────┘
                                   ▲
                                   │
                            ┌──────▼──────┐
                            │  happy-cli  │
                            │  (binary)   │
                            └─────────────┘
```

## What Gets Tested

### With Automated Credentials (Headless)
- ✅ Server startup and health
- ✅ Database connectivity (PostgreSQL)
- ✅ Real-time WebSocket connection
- ✅ Automated authentication flow (no user interaction)
- ✅ Session creation and tracking
- ✅ Daemon management (start, stop, list)
- ✅ CLI-server communication
- ✅ Machine registration

### With Web Client (Manual)
- ✅ Server startup and health
- ✅ Database connectivity
- ✅ Real-time WebSocket connection
- ✅ Authentication flow (QR code based)
- ✅ Session creation and tracking
- ✅ Encrypted communication
- ✅ CLI-server bidirectional communication
- ✅ Remote control from web client

## Next Steps

Once you have the web client running and can authenticate:

1. Try creating a session from the CLI
2. View it in the web client
3. Send commands from the web client
4. Verify they execute on the CLI side
5. Check real-time updates appear in both places

This confirms the full stack is working end-to-end!
