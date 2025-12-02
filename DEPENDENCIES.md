# Dependencies

This document lists all system and package dependencies required to run the Happy self-hosted stack.

## System Dependencies

These must be installed on the host system:

### Required
- **Node.js 24+** - Runtime for all JavaScript/TypeScript code
- **Yarn 1.22.22+** - Package manager (specified in package.json)
- **PostgreSQL 17+** - Primary database
- **Redis 7+** - Caching and pub/sub
- **MinIO** - S3-compatible object storage

### Optional
- **FFmpeg** - Required by happy-server for media processing
- **Python3** - Required by happy-server for some operations

## Installation Commands

### Ubuntu/Debian
```bash
# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Yarn
npm install -g yarn

# PostgreSQL 17
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y postgresql-17

# Redis
sudo apt-get install -y redis-server

# MinIO
wget https://dl.min.io/server/minio/release/linux-amd64/minio
chmod +x minio
sudo mv minio /usr/local/bin/
wget https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x mc
sudo mv mc /usr/local/bin/

# Optional: FFmpeg and Python3
sudo apt-get install -y ffmpeg python3
```

## Package Dependencies

After installing system dependencies, install package dependencies:

```bash
make install
```

This runs `yarn install` in each submodule:
- `happy-cli/` - Installs CLI dependencies including:
  - `tsx` - TypeScript executor (devDependency)
  - `shx` - Cross-platform shell commands (devDependency)
  - `pkgroll` - Package bundler (devDependency)
  - And all production dependencies

- `happy-server/` - Installs server dependencies including:
  - `tsx` - TypeScript executor (production dependency)
  - Prisma ORM and other server dependencies

- `happy/` - Installs webapp dependencies (Expo/React Native)

## Dependency Check

The `happy-launcher.sh` script automatically checks for installed package dependencies before starting services. If you see this error:

```
[ERROR] Dependencies not installed in happy-cli
```

Run:
```bash
make install
```

## CI Dependencies

The GitHub Actions CI workflow (`.github/workflows/ci.yml`) installs all dependencies automatically:
1. Node.js 24 via `setup-node` action
2. PostgreSQL 17 and Redis 7 via Docker services
3. MinIO server and client downloaded during workflow
4. Playwright for browser automation testing
5. All package dependencies via `yarn install --frozen-lockfile`
