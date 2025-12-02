# Happy Self-Hosted Setup

This repository contains a working self-hosted setup of Happy (server + CLI) with automated e2e testing.

## QUICKSTART: Self Hosting

### Step 0: Build and Launch Services

Run your own Happy instance with two containers - one for the webapp and one for the server:

```bash
cd .devcontainer
make build                # Build the container image (first time only)

# In terminal 1 - start the server (port 3005):
make server

# In terminal 2 - start the webapp (port 8081):
make web
```

**Other container options:**
- `make root` - Interactive shell with no ports forwarded
- `make root-all-ports` - Interactive shell with both ports (8081 + 3005) forwarded

### Step 1: Create an Account

1. Open http://localhost:8081 in your browser
2. Click "Create Account"
3. Optionally add a recognizable username in Account settings

### Step 2: View Your Secret Key

1. Go to Account settings in the webapp
2. Find and copy your secret backup key (format: `XXXXX-XXXXX-...`)

### Step 3: Install the CLI on Development Machines

On each machine where you want to run Claude with Happy:

```bash
# Clone and install the fork
git clone --depth=1 https://github.com/rrnewton/happy-cli.git /usr/local/happy
cd /usr/local/happy
npm install
npm run build
npm install -g .
```

### Step 4: Authenticate the CLI

Use the secret key from Step 2 to authenticate:

```bash
happy auth login --backup-key <YOUR-SECRET-KEY>
```

### Step 5: Start the Daemon

```bash
happy daemon start
```

The daemon connects your machine to the Happy server, allowing remote control from the webapp.

### Step 6: (Optional) Voice Assistant Setup

For ElevenLabs voice assistant integration:
1. Go to Account > Voice Assistant in the webapp
2. Click "Get API Key" to create an ElevenLabs API key with required permissions
3. Enter your API key and save credentials
4. Use "Find Agent" or "Create/Update Agent" to set up the voice agent

## Getting Started

### Build and Run Container

If you're not already inside the development container:

```bash
./build_and_run_container.sh
```

This builds the container image and starts it with all necessary ports forwarded (3005, 8081, 9000, 9001, 5432, 6379).

Alternatively, you can use the Makefile directly:
```bash
cd .devcontainer && make build root
```

### Branch Structure

**Base Development (`happy` branch):**
- Parent repo on `happy` branch
- All submodules on `main` branch tracking `origin/main`
- Each submodule's `origin/main` stays rebased on `upstream/main`

**Feature Development (`happy-X` branch):**
- Parent repo on `happy-X` branch
- All submodules on `feature-X` branch
- Feature name tracked in `feature_name.txt` (added to git)

### Makefile Commands

```bash
make setup           # Configure submodule remotes and branches
make status          # Show current branch status
make rebase-upstream # Rebase all submodules on upstream/main
make feature-start FEATURE=name  # Start a new feature
make feature-end     # End feature and return to base development
```

### Remote Configuration

Each submodule maintains two remotes:
- `origin` → `git@github.com:rrnewton/happy*` (your fork)
- `upstream` → `git@github.com:slopus/happy*` (upstream repo)

## Quick Start

### CLI Only (Headless)

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

### With Web Client (Full Stack)

```bash
# Start all services + web frontend
./e2e-web-demo.sh
```

This will:
1. Start all backend services
2. Create test credentials
3. Start the web client at http://localhost:8081
4. Start CLI daemon and session
5. Guide you through connecting from the browser

See [WEB_CLIENT_GUIDE.md](WEB_CLIENT_GUIDE.md) for detailed instructions.

## What's Working

✅ **happy-server** running on port 3005
✅ **happy-cli** with full daemon support
✅ **Happy web client** (browser UI on port 8081)
✅ **Automated authentication** (no browser/mobile app needed for testing)
✅ **Session creation and tracking**
✅ **Remote session control from web UI**
✅ **Database connectivity** (PostgreSQL, Redis, MinIO)
✅ **Real-time WebSocket communication**
✅ **Machine registration**

## Manual Usage

### Start Services

```bash
./happy-launcher.sh start    # Start all services
./happy-launcher.sh status   # Check what's running
./happy-launcher.sh stop     # Stop services
./happy-launcher.sh cleanup  # Stop everything including databases
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

- **[WEB_CLIENT_GUIDE.md](WEB_CLIENT_GUIDE.md)** - Browser UI setup and usage
- **[E2E_TESTING.md](E2E_TESTING.md)** - Complete e2e testing guide
- **[DEPENDENCIES.md](DEPENDENCIES.md)** - All installed dependencies
- **[CLAUDE.md](CLAUDE.md)** - Project instructions for Claude

## Key Scripts

### happy-launcher.sh
Main control script for managing services:
- `start` - Start all services (backend + webapp)
- `start-backend` - Start only backend services
- `start-webapp` - Start only the webapp
- `stop` - Stop happy-server, webapp, and MinIO
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
- **Happy Web Client**: http://localhost:8081/ (Expo/React Native web app)
- **MinIO Console**: http://localhost:9001/ (minioadmin/minioadmin)
- **Metrics**: http://localhost:9090/metrics
- **PostgreSQL**: postgresql://postgres:postgres@localhost:5432/handy
- **Redis**: redis://localhost:6379

All ports are automatically forwarded when using the devcontainer.

## Troubleshooting

### Server not responding
```bash
./happy-launcher.sh status          # Check all services
./happy-launcher.sh logs server     # View server logs
```

### Clean slate
```bash
./happy-launcher.sh cleanup --clean-logs   # Stop everything and clean logs
./happy-launcher.sh start                  # Fresh start
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
