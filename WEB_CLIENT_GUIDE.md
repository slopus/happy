# Happy Web Client Guide

This guide explains how to use the Happy web frontend to connect to and control self-hosted Happy CLI sessions.

## Overview

The Happy web client provides a browser-based interface to:
- Authenticate with the Happy server
- View and manage your machines
- Connect to and control active CLI sessions
- Monitor real-time session activity

## Quick Start

### 1. Start All Services

```bash
./happy-demo.sh start
```

This starts:
- PostgreSQL (database)
- Redis (cache)
- MinIO (object storage)
- happy-server (port 3005)

### 2. Start the Web Client

```bash
cd happy
yarn start:local-server
```

The web client will be available at: **http://localhost:8081**

This command configures the web client to connect to your local server at `http://localhost:3005`.

### 3. Authenticate

Open http://localhost:8081 in your browser. You'll see the Happy authentication screen with two options:

**Option A: Using Test Credentials (Easiest for Testing)**
```bash
# In another terminal, create test credentials
node scripts/setup-test-credentials.mjs

# The web client can use the same account
# Just open the web app and you'll be prompted to authenticate
```

**Option B: QR Code Authentication**
The web client will display a QR code. You can:
1. Scan it with the Happy mobile app (if available)
2. Or use the auto-auth script:
   ```bash
   # Get the public key from the QR code displayed in browser
   # Then run:
   node scripts/auto-auth.mjs <publicKey>
   ```

### 4. Start a CLI Session

Once authenticated in the web client, start a CLI session that it can control:

```bash
# Use test credentials to start a CLI session
export HAPPY_HOME_DIR=/root/.happy-dev-test
export HAPPY_SERVER_URL=http://localhost:3005

# Start daemon
./happy-cli/bin/happy.mjs daemon start

# Start a Claude Code session in remote mode
# This makes it controllable from the web UI
./happy-cli/bin/happy.mjs --happy-starting-mode remote
```

Or use the existing Claude Code integration:
```bash
# If you're already running in Claude Code, just start the daemon
HAPPY_HOME_DIR=/root/.happy-dev-test HAPPY_SERVER_URL=http://localhost:3005 \
  ./happy-cli/bin/happy.mjs daemon start
```

### 5. Connect from Web UI

In the browser:
1. You should see your machine listed
2. Click on the machine to view its sessions
3. Click on an active session to connect and control it
4. You can now send commands and see real-time output!

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│ Web Browser │ ◄────► │ happy-server │ ◄────► │  happy-cli  │
│ (port 8081) │   WS    │ (port 3005)  │   WS    │  (daemon)   │
└─────────────┘         └──────────────┘         └─────────────┘
                               │
                         ┌─────▼─────┐
                         │ PostgreSQL│
                         │   Redis   │
                         │   MinIO   │
                         └───────────┘
```

## Workflow Details

### Authentication Flow

1. **Web Client** generates an ephemeral keypair
2. Sends authentication request to **happy-server**
3. Server stores the request in database
4. User approves via:
   - Mobile app scanning QR code
   - Auto-auth script (for testing)
   - Another authenticated client
5. Server sends encrypted credentials back to web client
6. Web client decrypts and stores credentials locally

### Session Control

1. CLI starts in "remote" mode and connects to server via WebSocket
2. Server tracks the session and associates it with the machine
3. Web client subscribes to machine updates
4. When user selects a session in web UI:
   - Web client establishes WebSocket connection to server
   - Server bridges messages between web client and CLI
   - Commands flow: Web UI → Server → CLI
   - Output flows: CLI → Server → Web UI

### Real-time Updates

- All communication uses WebSockets for low-latency
- Session state is synced in real-time
- Multiple clients can observe the same session
- Encryption ensures security between client and CLI

## Configuration

### Environment Variables

The web client uses these environment variables (set in `yarn start:local-server`):

```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005
EXPO_PUBLIC_DEBUG=1
PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=1
```

To use a different server:
```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=https://your-server.com expo start --web
```

### CLI Configuration

The CLI needs to know where to connect:

```bash
export HAPPY_HOME_DIR=~/.happy-dev-test    # Or ~/.happy for production
export HAPPY_SERVER_URL=http://localhost:3005
```

## Troubleshooting

### Web client can't connect to server

Check that:
1. happy-server is running: `./happy-demo.sh status`
2. Server URL is correct in web client environment variables
3. No firewall is blocking port 3005

### Session doesn't appear in web UI

Check that:
1. CLI is authenticated: `./happy-cli/bin/happy.mjs auth status`
2. Daemon is running: `./happy-cli/bin/happy.mjs daemon status`
3. Session was started with `--happy-starting-mode remote`
4. Both CLI and web client are using the same server URL

### Authentication fails in web browser

Check:
1. Server logs: `./happy-demo.sh logs server`
2. Database is running: `./happy-demo.sh status`
3. Try creating fresh test credentials: `node scripts/setup-test-credentials.mjs`

### Web client shows "Loading..." forever

This usually means:
1. Metro bundler is still building (wait a minute)
2. Browser cache issue (hard refresh with Ctrl+Shift+R)
3. JavaScript error in console (check browser dev tools)

## Advanced Usage

### Multiple Sessions

You can run multiple CLI sessions simultaneously:

```bash
# Terminal 1
cd /tmp/project1
HAPPY_HOME_DIR=/root/.happy-dev-test ./happy-cli/bin/happy.mjs --happy-starting-mode remote

# Terminal 2
cd /tmp/project2
HAPPY_HOME_DIR=/root/.happy-dev-test ./happy-cli/bin/happy.mjs --happy-starting-mode remote
```

Both will appear in the web UI and can be controlled independently.

### Sharing Access

Multiple users can connect to the same server and see all sessions:

1. Each user authenticates separately
2. Server manages permissions (future feature)
3. Currently all users see all sessions

### Production Deployment

For production use:

1. Deploy happy-server to a VPS/cloud
2. Set up HTTPS with SSL certificates
3. Configure proper firewall rules
4. Use environment-specific URLs:
   ```bash
   EXPO_PUBLIC_HAPPY_SERVER_URL=https://your-domain.com expo build:web
   ```

## Next Steps

- Try controlling a CLI session from the web UI
- Explore the session history and logs
- Set up multiple machines and switch between them
- Configure custom authentication flows

## Related Documentation

- [E2E_TESTING.md](E2E_TESTING.md) - Complete testing guide
- [README.md](README.md) - Project overview
- [DEPENDENCIES.md](DEPENDENCIES.md) - Installed dependencies
