# Dependencies Installed

This document tracks all dependencies installed during the self-hosted setup process.

**Note**: All dependencies are now included in `.devcontainer/Dockerfile.project` for automatic installation when rebuilding the devcontainer.

## System Packages

### Docker
- **Package**: `docker.io`
- **Installed via**: `apt-get install -y docker.io`
- **Purpose**: Attempted for containerization but had WSL2 permission issues
- **Status**: Installed but not used
- **Alternative**: Installed services natively instead

### PostgreSQL
- **Package**: `postgresql`, `postgresql-contrib`
- **Installed via**: `apt-get install -y postgresql postgresql-contrib`
- **Purpose**: Database for happy-server
- **Used by**: happy-server
- **Database**: handy (auto-created by setup-postgres.sh)
- **Setup**: Fully automated via `setup-postgres.sh` (see Setup Notes below)

### Redis
- **Package**: `redis-server`
- **Installed via**: `apt-get install -y redis-server`
- **Purpose**: Cache and pub/sub for happy-server
- **Used by**: happy-server
- **Port**: 6379

## Node.js Dependencies

### happy-server
- Installed via `yarn install` in `/happy-server/`
- Includes: Fastify, Prisma, Socket.io, Redis client, MinIO SDK, etc.
- See `/happy-server/package.json` for full list

### happy-cli
- Installed via `yarn install` in `/happy-cli/`
- Includes: Claude Code SDK, Socket.io client, TweetNaCl for encryption, etc.
- See `/happy-cli/package.json` for full list

## Services (Docker Containers)

### PostgreSQL
- **Image**: `postgres:latest`
- **Port**: 5432
- **Database**: handy
- **Credentials**: postgres/postgres
- **Started via**: `yarn db` in happy-server

### Redis
- **Image**: `redis:latest`
- **Port**: 6379
- **Started via**: `yarn redis` in happy-server

### MinIO (S3-compatible storage)
- **Binary**: MinIO standalone server
- **Installed via**: `wget https://dl.min.io/server/minio/release/linux-amd64/minio`
- **Ports**: 9000 (API), 9001 (Console)
- **Credentials**: minioadmin/minioadmin
- **Data directory**: `/happy-all-WinGamingPC/happy-server/.minio/data`
- **Bucket**: `happy` (created with MinIO client)
- **Started via**: `minio server .minio/data --address :9000 --console-address :9001`

### MinIO Client (mc)
- **Binary**: MinIO client for bucket management
- **Installed via**: `wget https://dl.min.io/client/mc/release/linux-amd64/mc`
- **Used for**: Creating and configuring S3 buckets

### lsof
- **Package**: `lsof`
- **Installed via**: `apt-get install -y lsof`
- **Purpose**: Used by happy-server dev script to kill existing processes on port 3005
- **Used by**: happy-server

## Testing Scripts

### setup-postgres.sh
- **Location**: `/setup-postgres.sh`
- **Purpose**: Automated PostgreSQL setup and verification script
- **Checks**: Password configuration, database existence, schema migrations
- **Usage**: `./setup-postgres.sh` (or called automatically by e2e-demo.sh)
- **Features**: Idempotent - safe to run multiple times

### setup-test-credentials.mjs
- **Location**: `/scripts/setup-test-credentials.mjs`
- **Purpose**: Automates authentication flow for headless e2e testing
- **Dependencies**: tweetnacl, axios (via symlink to happy-cli/node_modules)
- **Creates**: Test credentials in `~/.happy-dev-test/`
- **Usage**: `node scripts/setup-test-credentials.mjs`
- **Note**: Kept outside happy-cli repo to avoid dirtying the system-under-test. Uses a symlink to happy-cli/node_modules for dependencies.

### e2e-demo.sh
- **Location**: `/e2e-demo.sh`
- **Purpose**: Complete e2e demo script that shows the full self-hosted flow
- **Dependencies**: setup-postgres.sh, happy-launcher.sh, setup-test-credentials.mjs
- **Usage**: `./e2e-demo.sh`

## Environment Variables

### For Testing
- `HAPPY_HOME_DIR=/root/.happy-dev-test` - Test credentials directory (separate from prod)
- `HAPPY_SERVER_URL=http://localhost:3005` - Local server URL

## Directory Structure

The `/scripts` directory contains e2e testing scripts and uses a symlink to access happy-cli dependencies:
```
scripts/
├── setup-test-credentials.mjs
├── auto-auth.mjs
└── node_modules -> ../happy-cli/node_modules  (symlink)
```

This approach keeps the system-under-test repos (happy-cli, happy-server) clean while allowing test scripts to access necessary dependencies.

## Setup Notes

### PostgreSQL Initial Setup

PostgreSQL setup is **fully automated** via the `setup-postgres.sh` script, which is called automatically by `e2e-demo.sh`.

The setup script checks and fixes:
1. PostgreSQL password configuration (sets to `postgres` if needed)
2. Database existence (creates `handy` database if missing)
3. Database schema (runs Prisma migrations if tables are missing)

**Manual setup is no longer required.** Just run `./e2e-demo.sh` and it will handle everything.

#### Manual Setup Script

If you need to run the PostgreSQL setup manually:
```bash
./setup-postgres.sh
```

This script is idempotent - it's safe to run multiple times and will only make changes if needed.

#### What the Script Does

1. **Checks PostgreSQL is running** - Exits if PostgreSQL service is not started
2. **Verifies password** - Sets `postgres` user password to `postgres` if not configured
3. **Creates database** - Creates `handy` database if it doesn't exist
4. **Runs migrations** - Executes Prisma migrations if database tables are missing

The script expects:
- Database credentials: `postgres:postgres@localhost:5432/handy` (as configured in happy-server/.env)
- PostgreSQL service to be running (start with `service postgresql start`)

### Common Issues

**Issue**: "PostgreSQL is not running"
**Solution**: Start PostgreSQL with `service postgresql start`

**Issue**: Server fails to start with database errors
**Solution**: Run `./setup-postgres.sh` manually to verify and fix setup

## Browser Automation (Playwright)

### Installation

Playwright with Chromium is installed for headless browser testing of the webapp.

```bash
# Install Playwright globally
npm install -g playwright

# Install Chromium browser binaries
npx playwright install chromium

# Install system dependencies (fonts, xvfb, etc.)
npx playwright install-deps chromium
```

### System Packages Installed by Playwright

The `playwright install-deps chromium` command installs:
- `xvfb` - X Virtual Frame Buffer for headless display
- `fonts-*` - Various fonts for proper text rendering
- `libnss3`, `libnspr4` - Security libraries
- Various X11 libraries for graphics rendering

### Browser Test Scripts

Located in `/scripts/browser/`:

- **`inspect-webapp.mjs`** - Basic webapp inspection and screenshot tool
- **`test-webapp-e2e.mjs`** - Full E2E test with login flow

### Usage

```bash
cd /happy-all-WinGamingPC/scripts/browser

# Basic inspection with screenshot
node inspect-webapp.mjs --screenshot --console

# Full E2E test with login
node test-webapp-e2e.mjs "YOUR-SECRET-KEY"
```

### Environment Variables

- `WEBAPP_URL` - Override webapp URL (default: `http://localhost:8081`)
- `SCREENSHOT_DIR` - Directory for screenshots (default: `/tmp`)

### Screenshots

Screenshots are saved to `/tmp/` with timestamps:
- `happy-e2e-01-initial-{timestamp}.png`
- `happy-e2e-02-after-create-click-{timestamp}.png`
- etc.
