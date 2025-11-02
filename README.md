# Happy Self-Hosted Setup

This repository contains a working self-hosted setup of Happy (server + CLI) with automated e2e testing.

## Quick Start

```bash
# Start all services and run complete e2e demo
./e2e-demo.sh
```

This will:
1. Start PostgreSQL, Redis, MinIO, and happy-server
2. Create test credentials automatically (no user interaction needed!)
3. Start the daemon
4. Create and track a test session
5. Show you everything working

## What's Working

✅ **happy-server** running on port 3005
✅ **happy-cli** with full daemon support
✅ **Automated authentication** (no browser/mobile app needed for testing)
✅ **Session creation and tracking**
✅ **Database connectivity** (PostgreSQL)
✅ **Real-time WebSocket communication**
✅ **Machine registration**

## Manual Usage

### Start Services

```bash
./happy-demo.sh start    # Start all services
./happy-demo.sh status   # Check what's running
./happy-demo.sh stop     # Stop services
./happy-demo.sh cleanup  # Stop everything including databases
```

### Setup Test Credentials

```bash
node scripts/setup-test-credentials.mjs
```

This creates credentials in `~/.happy-dev-test/` without requiring any user interaction.

### Use the CLI

```bash
# Set environment variables
export HAPPY_HOME_DIR=/root/.happy-dev-test
export HAPPY_SERVER_URL=http://localhost:3005

# Check authentication
./happy-cli/bin/happy.mjs auth status

# Start daemon
./happy-cli/bin/happy.mjs daemon start

# List sessions
./happy-cli/bin/happy.mjs daemon list
```

## Architecture

```
┌─────────────────┐         ┌──────────────┐         ┌─────────────┐
│   happy-cli     │ ◄────► │ happy-server │ ◄────► │ PostgreSQL  │
│   (daemon)      │   WS    │ (port 3005)  │         │  (port 5432)│
└─────────────────┘         └──────────────┘         └─────────────┘
                                   │
                              ┌────▼────┐
                              │  Redis  │
                              │ (6379)  │
                              └─────────┘
                                   │
                              ┌────▼────┐
                              │  MinIO  │
                              │  (9000) │
                              └─────────┘
```

## Documentation

- **[E2E_TESTING.md](E2E_TESTING.md)** - Complete e2e testing guide
- **[DEPENDENCIES.md](DEPENDENCIES.md)** - All installed dependencies
- **[CLAUDE.md](CLAUDE.md)** - Project instructions for Claude

## Key Scripts

### happy-demo.sh
Main control script for managing services:
- `start` - Start all services
- `stop` - Stop happy-server and MinIO
- `cleanup` - Stop everything including databases
- `status` - Show service status
- `logs <service>` - View logs
- `cli` - Run CLI with local config
- `test` - Test connectivity

### setup-test-credentials.mjs
Automates the authentication flow for headless testing. This script:
1. Creates a test account on the server
2. Simulates the CLI auth request
3. Auto-approves the request
4. Saves credentials to disk

No browser or mobile app needed!

### e2e-demo.sh
Complete end-to-end demonstration script that shows the full flow working.

## Service URLs

- **happy-server**: http://localhost:3005/
- **MinIO Console**: http://localhost:9001/ (minioadmin/minioadmin)
- **Metrics**: http://localhost:9090/metrics
- **PostgreSQL**: postgresql://postgres:postgres@localhost:5432/handy
- **Redis**: redis://localhost:6379

## Troubleshooting

### Server not responding
```bash
./happy-demo.sh status          # Check all services
./happy-demo.sh logs server     # View server logs
```

### Clean slate
```bash
./happy-demo.sh cleanup --clean-logs   # Stop everything and clean logs
./happy-demo.sh start                  # Fresh start
```

### Database issues
```bash
cd happy-server
yarn migrate                    # Run migrations
```

## Integration Tests

The CLI includes integration tests that work with the automated credentials:

```bash
cd happy-cli
yarn test:integration-test-env
```

## What's Next?

This setup demonstrates:
- ✅ Self-hosted Happy server and CLI
- ✅ Automated authentication for testing
- ✅ Full daemon lifecycle
- ✅ Session management

Potential improvements:
- [ ] Add web client to the demo
- [ ] Add Docker Compose configuration
- [ ] Add health check endpoints
- [ ] Add automated backup scripts
- [ ] Add monitoring/alerting setup
