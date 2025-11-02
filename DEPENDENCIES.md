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
- **Database**: handy (created during setup)

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
