# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**For shared development principles and mono-repo overview, see [CLAUDE.md](../CLAUDE.md)**

## Component Overview

Happy Server - Minimal, end-to-end encrypted synchronization backend for AI coding clients, enabling secure multi-device sync while maintaining zero-knowledge privacy (server stores encrypted data but cannot read it).

## Core Technology Stack

- **Web Framework**: Fastify 5 with fastify-type-provider-zod for type safety
- **Database**: PostgreSQL with Prisma ORM
- **Validation**: Zod for runtime and compile-time type checking
- **Real-time**: Socket.io with Redis adapter for horizontal scaling
- **Cache/Pub-Sub**: Redis (ioredis)
- **Object Storage**: Minio (S3-compatible)
- **Cryptography**: privacy-kit, tweetnacl
- **Testing**: Vitest
- **Metrics**: Prometheus (prom-client)
- **Package Manager**: Yarn (not npm)

## Development Commands

### Essential Commands
- `yarn build` - TypeScript type checking (no emit)
- `yarn start` - Start production server
- `yarn dev` - Start development server with hot reload (kills process on port 3005)
- `yarn test` - Run Vitest test suite
- `yarn generate` - Generate Prisma client (run after schema changes)
- `yarn migrate` - Run Prisma migrations (dev only)
- `yarn migrate:reset` - Reset database and re-run migrations

### Infrastructure Commands
- `yarn db` - Start local PostgreSQL in Docker
- `yarn redis` - Start local Redis in Docker
- `yarn s3` - Start local Minio in Docker
- `yarn s3:down` - Stop Minio container
- `yarn s3:init` - Initialize Minio buckets

### Environment Requirements
- **FFmpeg** - Required for media processing
- **Python3** - Required for certain operations
- **PostgreSQL** - Database (use `yarn db` for local)
- **Redis** - Required for event bus and caching (use `yarn redis` for local)
- **Minio** - Object storage (use `yarn s3` for local)

### Environment Files
- `.env` - Base environment configuration
- `.env.dev` - Development overrides
- Server uses `.env` and `.env.dev` when running `yarn dev`

## Code Style and Structure

### Naming Conventions
- Directories: lowercase with dashes (e.g., `components/auth-wizard`)
- Utility files: name file and function the same way for easy discovery
- Test files: same name as source with `.spec.ts` suffix (e.g., `lru.spec.ts`)
- Action files: prefix with entity type then action (e.g., `sessionAdd.ts`, `friendRemove.ts`)

### Directory Structure
```
/sources/                           # Source root
├── main.ts                         # Application entry point
├── context.ts                      # User context wrapper
├── /app                            # Application-specific logic
│   ├── /api                       # API server application
│   │   ├── api.ts                 # Fastify server setup
│   │   ├── socket.ts              # Socket.io setup
│   │   ├── /routes                # HTTP route handlers (15 routes)
│   │   ├── /socket                # WebSocket handlers (7 handlers)
│   │   ├── /utils                 # API middleware (auth, monitoring, errors)
│   │   └── types.ts               # TypeScript types
│   ├── /auth                      # Cryptographic authentication
│   ├── /events                    # Event router for real-time updates
│   ├── /feed                      # User activity feed
│   ├── /github                    # GitHub OAuth integration
│   ├── /kv                        # Encrypted key-value storage
│   ├── /monitoring                # Prometheus metrics
│   ├── /presence                  # Session/machine presence tracking
│   ├── /session                   # Session management
│   └── /social                    # Friends and relationships
├── /modules                        # Reusable modules (non-application)
│   ├── encrypt.ts                 # Encryption utilities (privacy-kit wrapper)
│   └── github.ts                  # GitHub integration module
├── /storage                        # Database and storage abstractions
│   ├── db.ts                      # Prisma client
│   ├── inTx.ts                    # Transaction wrapper with retry
│   ├── redis.ts                   # Redis client
│   ├── files.ts                   # S3/Minio client
│   ├── repeatKey.ts               # Idempotency keys
│   ├── seq.ts                     # Sequence allocation
│   └── simpleCache.ts             # Caching utilities
└── /utils                          # Low-level utilities
    ├── log.ts                     # Logging
    ├── delay.ts                   # Delays
    ├── lock.ts                    # Lock utilities
    ├── shutdown.ts                # Graceful shutdown
    └── ...
```

## Core Architecture

### Application Startup Flow (`sources/main.ts`)

The server follows a clean initialization sequence:

1. **Storage Initialization** - Connect to PostgreSQL and Redis
2. **Module Initialization** - Initialize encryption (privacy-kit), GitHub integration, load S3 files, initialize auth
3. **Server Startup** - Start Fastify API server (port 3005), Prometheus metrics server, timeout monitor, Socket.io server
4. **Graceful Shutdown** - All components register cleanup handlers via `onShutdown()`

### API Server (`sources/app/api/api.ts`)

**Fastify 5** with type-safe routing:
- **Type Safety**: `fastify-type-provider-zod` for compile-time and runtime validation
- **Body Limit**: 100MB for file uploads
- **Middleware**: Authentication (Bearer token), error handling, Prometheus metrics
- **15 Route Modules**: `/v1/auth`, `/v1/sessions`, `/v1/machines`, `/v1/artifacts`, `/v1/access-keys`, `/v1/account`, `/v1/connect`, `/v1/push`, `/v1/voice`, `/v1/users`, `/v1/feed`, `/v1/kv`, `/v1/version`, `/dev`
- **Port**: 3005 (configurable via `PORT` env var)

### Real-time Communication (`sources/app/api/socket.ts`)

**Socket.io** with sophisticated connection scoping:

**Three Connection Types:**
1. **User-scoped** - Receives all updates for a user (mobile/web apps)
2. **Session-scoped** - Receives updates for a specific session (dedicated views)
3. **Machine-scoped** - Receives updates for a specific machine/daemon

**Socket Handlers** (7 specialized handlers):
- `sessionUpdateHandler` - Session updates
- `machineUpdateHandler` - Machine state sync
- `artifactUpdateHandler` - Artifact updates
- `accessKeyHandler` - Access key management
- `rpcHandler` - Remote procedure calls
- `usageHandler` - Usage reporting
- `pingHandler` - Keepalive

### Event Router (`sources/app/events/eventRouter.ts`)

Sophisticated event routing system with two event types:

**1. Persistent Updates** (`emitUpdate`): Stored in database changes
- Event types: `new-session`, `update-session`, `delete-session`, `new-message`, `new-machine`, `update-machine`, `new-artifact`, `update-artifact`, `delete-artifact`, `update-account`, `relationship-updated`, `new-feed-post`, `kv-batch-update`

**2. Ephemeral Events** (`emitEphemeral`): Transient status updates
- Event types: `activity`, `machine-activity`, `usage`, `machine-status`

**Recipient Filters:**
- `all-user-authenticated-connections` - Default (all connection types)
- `user-scoped-only` - Mobile/web only
- `session-scoped` - Specific session + user-scoped
- `machine-scoped-only` - Specific machine + user-scoped

### Database Architecture (`prisma/schema.prisma`)

**Core Entities:**
- **Account** - User accounts with public key auth, GitHub integration, profile
- **Session** - Encrypted chat sessions with metadata, agent state, encryption keys
- **SessionMessage** - Messages within sessions with sequencing
- **Machine** - Daemon instances with encrypted metadata and state
- **Artifact** - End-to-end encrypted artifacts with header/body separation
- **UserRelationship** - Friend relationships with status tracking
- **UserFeedItem** - Activity feed with sequence-based ordering
- **UserKVStore** - Encrypted key-value storage
- **AccessKey** - Shared access keys for sessions

**Key Patterns:**
- **Versioned Fields**: `metadataVersion`, `agentStateVersion` for optimistic locking
- **Encrypted Storage**: Sensitive data stored as encrypted strings/bytes
- **Indexes**: Strategic indexes on `accountId`, `updatedAt`, `seq` for performance

### Transaction Management (`sources/storage/inTx.ts`)

**`inTx()` wrapper** provides:
- **Serializable Isolation Level** - Prevents race conditions
- **Automatic Retry** - Up to 3 retries with exponential backoff for serialization failures
- **After-commit Callbacks** - `afterTx()` for events that fire only after successful commit

**CRITICAL**: Always use `inTx()` for database operations. Never run non-transactional operations (like file uploads) inside transactions.

### Cryptographic Authentication (`sources/app/auth/auth.ts`)

**Privacy-kit based authentication:**
- **No Passwords** - Public key signature verification only
- **Token Types**:
  - Persistent tokens for API authentication
  - Ephemeral 5-minute tokens for GitHub OAuth flow
- **Token Caching** - In-memory cache for verified tokens
- **User Invalidation** - Can invalidate all user's tokens

### Security Model

**End-to-End Encryption:**
- Encryption keys generated on client
- Server stores encrypted data only
- Data encryption keys stored encrypted with server-side keys
- Server cannot read user messages, metadata, or state

**Authentication:**
- Public key cryptography (NaCl)
- No passwords stored
- Challenge-response signature verification
- Persistent tokens for API access

## Development Guidelines

For detailed server development rules, see @../.claude/rules/server.md

Key points:
- **Always use `inTx()`** for database operations
- **Never run non-transactional operations** (like file uploads) inside transactions
- **CRITICAL**: NEVER create migrations yourself - only run `yarn generate` when new types are needed
- **Always use `privacyKit.decodeBase64` and `privacyKit.encodeBase64`** from privacy-kit instead of Buffer
- **Action Files**: Create dedicated files in relevant `sources/app/` subfolders (e.g., `sessionAdd.ts`, `friendRemove.ts`)
- **Return Values**: Only return essential data from action functions, not "just in case" values

For shared code style guidelines, see @../.claude/rules/code-style.md
For testing guidelines, see @../.claude/rules/testing.md
For TypeScript rules, see @../.claude/rules/typescript.md

## Docker Deployment

**Multi-stage Dockerfile:**
1. **Builder Stage** - Node.js 20 with dependencies and build
2. **Runner Stage** - Minimal Node.js 20 runtime with FFmpeg and Python3
3. **Exposed Port**: 3000
4. **Command**: `yarn start`

**Deployment Configs:**
- `deploy/handy.yaml` - Kubernetes/main deployment
- `deploy/happy-redis.yaml` - Redis deployment

## Debugging Notes

### Remote Logging Setup
- Enable with `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=true` env var
- Server logs to `.logs/` directory with timestamped files (format: `MM-DD-HH-MM-SS.log`)
- Mobile and CLI send logs to `/logs-combined-from-cli-and-mobile-for-simple-ai-debugging` endpoint

### Common Issues & Tells

**Socket/Connection Issues:**
- "Sending update to user-scoped connection" but mobile not updating
- Multiple "User disconnected" messages indicate socket instability
- "Response from the Engine was empty" = Prisma database connection lost

**Auth Flow:**
- CLI hits `/v1/auth/request` to create auth request
- Mobile scans QR and hits `/v1/auth/response` to approve
- 404 on `/v1/auth/response` = server likely restarted/crashed
- "Auth failed - user not found" = token issue or user doesn't exist

**Session Creation:**
- Sessions created via POST `/v1/sessions` with tag-based deduplication
- Server emits "new-session" update to all user connections
- Sessions created but not showing = mobile app not processing updates
- "pathname /" in mobile logs = app stuck at root screen

**Environment Variables:**
- Server: Use `yarn dev` to start with proper env files
- Wrong server URL = check `HAPPY_SERVER_URL` env var
- Wrong home dir = check `HAPPY_HOME_DIR` (should be `~/.happy-dev` for local)

### Quick Diagnostic Commands

**Always Start Debugging With These:**
```bash
# Check current time - logs use local time
date

# Check latest log files - server creates new logs on restart
ls -la .logs/*.log | tail -5

# Verify you're looking at current logs
# Logs named: MM-DD-HH-MM-SS.log (month-day-hour-min-sec)
tail -1 .logs/[LATEST_LOG_FILE]
```

**Common Debugging Patterns:**
```bash
# Check server logs for errors
tail -100 .logs/*.log | grep -E "(error|Error|ERROR|failed|Failed)"

# Monitor session creation
tail -f .logs/*.log | grep -E "(new-session|Session created)"

# Check active connections
tail -100 .logs/*.log | grep -E "(Token verified|User connected|User disconnected)"

# See what endpoints are being hit
tail -100 .logs/*.log | grep "incoming request"

# Debug socket real-time updates
tail -500 .logs/*.log | grep -A 2 -B 2 "new-session" | tail -30
tail -200 .logs/*.log | grep -E "(websocket|Socket.*connected|Sending update)" | tail -30

# Track socket events from mobile client
tail -300 .logs/*.log | grep "remote-log.*mobile" | grep -E "(SyncSocket|handleUpdate)" | tail -20

# Monitor session creation flow
tail -500 .logs/*.log | grep "session-create" | tail -20
tail -500 .logs/*.log | grep "[SESSION_ID]" -A 3 -B 3

# Debug machine registration and online status
tail -500 .logs/*.log | grep -E "(machine-alive|machine-register|update-machine)" | tail -20
```

### Time Format Reference
- **CLI logs**: `[HH:MM:SS.mmm]` in local time (e.g., `[13:45:23.738]`)
- **Server logs**: Include both `time` (Unix ms) and `localTime` (HH:MM:ss.mmm)
- **Mobile logs**: Sent with `timestamp` in UTC, converted to `localTime` on server
- **All consolidated logs**: Have `localTime` field for easy correlation
