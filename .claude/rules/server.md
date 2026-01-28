---
paths:
- "server/**/*.ts"
---

# Server Development Rules

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

## Database Operations

### Transaction Management
- **CRITICAL**: Always use `inTx()` for database operations
- **Serializable isolation level** - Prevents race conditions
- **Automatic retry** - Up to 3 retries with exponential backoff for serialization failures
- **After-commit callbacks** - `afterTx()` for events that fire only after successful commit

### Transaction Rules
- **NEVER run non-transactional operations** (like file uploads) inside transactions
- **Use version fields** for optimistic locking (e.g., `metadataVersion`, `agentStateVersion`)
- **Use `Json` type** for complex data

### Prisma ORM
- **Used for all database operations**
- **CRITICAL**: NEVER create migrations yourself - only run `yarn generate` when new types are needed

### Transaction Wrapper Pattern
```typescript
import { inTx } from '@/storage/inTx';

await inTx(async (db) => {
    // All database operations here
    const session = await db.session.create({ ... });

    // Use afterTx() for events that fire after commit
    afterTx(() => {
        eventRouter.emitUpdate('new-session', { ... });
    });
});
```

## API Development

### Route Structure
- **Routes** located in `sources/app/api/routes/`
- **Type Safety**: Use Zod schemas for all route validation
- **Authentication**: Use `authenticate` preHandler for protected routes
- **Idempotency**: Design all operations to be idempotent; clients may retry requests automatically
- **Error Handling**: Centralized error handlers in `sources/app/api/utils/`

### Route Development Pattern
```typescript
import { z } from 'zod';
import { authenticate } from '@/app/api/utils/auth';

const schema = {
    body: z.object({
        // Request body validation
    }),
    response: {
        // Response validation
    }
};

app.post('/v1/endpoint', {
    preHandler: [authenticate],
    schema
}, async (request, response) => {
    // Route handler
});
```

### Idempotency
- **All operations must be idempotent**
- Clients may retry requests automatically on failure
- Use tag-based deduplication for session creation
- Use repeat keys for operations that need idempotency

## Event Handling

### Event Router
- **Use `afterTx()`** - Send events after transaction commit, not directly
- **Event Router** - Use `eventRouter.emitUpdate()` for persistent updates, `eventRouter.emitEphemeral()` for transient events
- **Recipient Filters** - Choose appropriate filter for your use case

### Event Types

**Persistent Updates** (`emitUpdate`): Stored in database changes
- Event types: `new-session`, `update-session`, `delete-session`, `new-message`, `new-machine`, `update-machine`, `new-artifact`, `update-artifact`, `delete-artifact`, `update-account`, `relationship-updated`, `new-feed-post`, `kv-batch-update`

**Ephemeral Events** (`emitEphemeral`): Transient status updates
- Event types: `activity`, `machine-activity`, `usage`, `machine-status`

### Recipient Filters
- `all-user-authenticated-connections` - Default (all connection types)
- `user-scoped-only` - Mobile/web only
- `session-scoped` - Specific session + user-scoped
- `machine-scoped-only` - Specific machine + user-scoped

## Cryptography

### Encoding/Decoding
- **Always use `privacyKit.decodeBase64` and `privacyKit.encodeBase64`** from privacy-kit instead of Buffer directly

### Security Model
- **End-to-End Encryption**: Server stores encrypted data only
- **Authentication**: Public key cryptography (NaCl), no passwords
- **Challenge-response**: Signature verification
- **Zero-knowledge**: Server cannot read user messages, metadata, or state

## File Operations

### Action Files
- **Create dedicated files** in relevant `sources/app/` subfolders for operations
- **Naming**: Prefix with entity type then action (e.g., `sessionAdd.ts`, `friendRemove.ts`)
- **NEVER create files unless absolutely necessary**
- **ALWAYS prefer editing existing files over creating new ones**

### Return Values
- **Only return essential data** from action functions, not "just in case" values
- **Logging**: Do not add logging when not asked
- **Comments**: Add documentation comments that explain logic after writing actions

### Directory Naming
- **Lowercase with dashes** (e.g., `components/auth-wizard`)
- **Utility files**: Name file and function the same way for easy discovery
- **Test files**: Same name as source with `.spec.ts` suffix

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

### Environment Files
- `.env` - Base environment configuration
- `.env.dev` - Development overrides
- Server uses `.env` and `.env.dev` when running `yarn dev`

## Architecture Overview

### Application Startup Flow (`sources/main.ts`)
1. **Storage Initialization** - Connect to PostgreSQL and Redis
2. **Module Initialization** - Initialize encryption (privacy-kit), GitHub integration, load S3 files, initialize auth
3. **Server Startup** - Start Fastify API server (port 3005), Prometheus metrics server, timeout monitor, Socket.io server
4. **Graceful Shutdown** - All components register cleanup handlers via `onShutdown()`

### API Server (`sources/app/api/api.ts`)
- **Fastify 5** with type-safe routing
- **Body Limit**: 100MB for file uploads
- **Middleware**: Authentication (Bearer token), error handling, Prometheus metrics
- **15 Route Modules**
- **Port**: 3005 (configurable via `PORT` env var)

### Real-time Communication (`sources/app/api/socket.ts`)
**Three Connection Types:**
1. **User-scoped** - Receives all updates for a user (mobile/web apps)
2. **Session-scoped** - Receives updates for a specific session (dedicated views)
3. **Machine-scoped** - Receives updates for a specific machine/daemon

## Important Reminders

1. **Do what has been asked; nothing more, nothing less**
2. **NEVER create files unless absolutely necessary**
3. **ALWAYS prefer editing existing files over creating new ones**
4. **NEVER proactively create documentation files (*.md) unless explicitly requested**
5. **Use 4 spaces for indentation** (not 2 spaces)
6. **Use yarn instead of npm** for all package management
7. **NEVER create migrations yourself** - only run `yarn generate` when new types are needed
8. **Always use `inTx()` for database operations**
9. **Never run non-transactional operations** (like file uploads) inside transactions
10. **Always use `privacyKit.decodeBase64` and `privacyKit.encodeBase64`** from privacy-kit instead of Buffer

## See Also

- Detailed server documentation: @server/CLAUDE.md
- Code style guidelines: @.claude/rules/code-style.md
- Testing guidelines: @.claude/rules/testing.md
- TypeScript rules: @.claude/rules/typescript.md
