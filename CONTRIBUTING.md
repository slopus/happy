# Contributing / Developer Guide

This guide explains how to work on the Happy self-hosted setup.

## Repository Structure

This repo uses git submodules to combine three separate repositories:

```
happy/           # React Native webapp (Expo) - rrnewton/happy fork
happy-cli/       # CLI tool - rrnewton/happy-cli fork
happy-server/    # Node.js server - rrnewton/happy-server fork
```

Each submodule tracks `origin/rrnewton` (our fork) and can rebase on `upstream/main` (slopus upstream).

## Branch Conventions

- **Parent repo**: `happy` branch for mainline development
- **Submodules**: `rrnewton` branch tracks our changes
- **Features**: `happy-X` in parent, `feature-X` in submodules

## Development Workflow

### Inside the Container

Once inside the devcontainer, use `happy-launcher.sh` to manage services:

```bash
./happy-launcher.sh start          # Start all services (server + webapp)
./happy-launcher.sh start-backend  # Start backend only
./happy-launcher.sh start-webapp   # Start webapp only
./happy-launcher.sh stop           # Stop services
./happy-launcher.sh status         # Check what's running
./happy-launcher.sh logs server    # View server logs
./happy-launcher.sh cleanup        # Stop everything including databases
```

### Slot System

The launcher supports multiple isolated instances via `--slot`:

```bash
./happy-launcher.sh --slot 1 start   # Slot 1: ports 10001-10004, DB handy_test_1
./happy-launcher.sh --slot 2 start   # Slot 2: ports 10011-10014, DB handy_test_2
```

Slot 0 (default) uses standard ports (3005, 8081) and the `handy` database.

### Running Tests

```bash
./scripts/validate.sh        # Full validation (builds + unit + E2E)
./scripts/validate.sh --quick  # Quick mode (builds + unit tests only)
```

## Makefile Targets

```bash
make build           # Build all TypeScript (CLI and server)
make server          # Start all services
make stop            # Stop all services (daemon + cleanup all slots)
make logs            # View server logs
make validate        # Run validation tests
make push            # Push all repos to origin
```

### Repository Management

```bash
make setup           # Configure submodule remotes
make status          # Show branch status for all repos
make rebase-upstream # Rebase submodules on upstream/main
make feature-start FEATURE=name  # Start feature branch
make feature-end     # End feature, return to mainline
```

## Key Scripts

| Script | Purpose |
|--------|---------|
| `happy-launcher.sh` | Main service control script |
| `scripts/validate.sh` | CI validation (builds + tests) |
| `scripts/setup-test-credentials.mjs` | Create test auth without browser |
| `e2e-web-demo.sh` | Full E2E demo with browser tests |

## Service URLs (Slot 0)

| Service | URL |
|---------|-----|
| Server API | http://localhost:3005 |
| Webapp | http://localhost:8081 |
| MinIO Console | http://localhost:9001 (minioadmin/minioadmin) |
| PostgreSQL | postgresql://postgres:postgres@localhost:5432/handy |
| Redis | redis://localhost:6379 |

## Environment Variables

For CLI development:

```bash
export HAPPY_HOME_DIR=~/.happy-dev
export HAPPY_SERVER_URL=http://localhost:3005
export HAPPY_WEBAPP_URL=http://localhost:8081
```

## Test Credentials (Headless Testing)

For automated testing without a browser:

```bash
node scripts/setup-test-credentials.mjs
```

This creates credentials in `~/.happy-dev-test/` by simulating the full auth flow.
