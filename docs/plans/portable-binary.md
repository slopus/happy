# Portable Single-Binary Distribution

## Overview
Create a portable, self-contained distribution of happy-server as a single Bun-compiled binary. It runs without Redis (already has in-memory event bus), uses PGlite for embedded PostgreSQL, and local filesystem for file storage. CLI provides `happy-server migrate` and `happy-server serve` commands.

## Context
- **Event bus**: Already 100% in-memory (`eventRouter.ts`). Redis is only used for `redis.ping()` health check — zero actual pub/sub usage. `@socket.io/redis-streams-adapter` is a dependency but never imported in source code.
- **Database**: Prisma with PostgreSQL. `pglite-prisma-adapter` provides a Prisma driver adapter for PGlite. Requires `driverAdapters` preview feature in schema.
- **File storage**: S3/Minio used for image uploads (avatar uploads via GitHub connect). Used in `uploadImage.ts`, `files.ts`, referenced in `eventRouter.ts`, `accountRoutes.ts`, `type.ts`.
- **Migrations**: 36 SQL migration files in `prisma/migrations/`. PGlite adapter doesn't support `prisma migrate` CLI, so we apply SQL files directly via PGlite.
- **Bun+PGlite compile limitation**: There's a [known Bun issue](https://github.com/oven-sh/bun/issues/15032) where PGlite WASM files can't be embedded in `--compile` output. Workaround: copy `postgres.data`/`postgres.wasm` files next to binary.

## Development Approach
- Complete each task fully before moving to the next
- Make small, focused changes
- Minimal changes to existing code — prefer conditional paths over rewrites
- Test by running the standalone binary after build

## Implementation Steps

### Task 1: Add PGlite + adapter dependencies
- [ ] Add `@electric-sql/pglite`, `pglite-prisma-adapter` to happy-server dependencies
- [ ] Add `driverAdapters` to `previewFeatures` in `prisma/schema.prisma` generator block
- [ ] Run `prisma generate` to regenerate client with adapter support
- [ ] Verify existing server still works (no breaking changes from preview feature)

### Task 2: Make database layer PGlite-aware
- [ ] Modify `sources/storage/db.ts` to conditionally use PGlite when `PGLITE_DIR` env var is set
  - If `PGLITE_DIR` is set: create PGlite instance with that dir, wrap in `PrismaPGlite` adapter, pass to `new PrismaClient({ adapter })`
  - If not set: use existing `new PrismaClient()` (connects via `DATABASE_URL` as before)
- [ ] Export a `getPGlite()` function for direct SQL access (needed by migration command)

### Task 3: Make Redis optional
- [ ] In `main.ts`, make `redis.ping()` conditional — only if `REDIS_URL` env var is set
- [ ] Skip redis import when not needed (dynamic import or guard)

### Task 4: Replace S3 with local filesystem storage
- [ ] Modify `sources/storage/files.ts`:
  - If S3 env vars are set: use existing Minio client (no change)
  - If not: use local filesystem under `DATA_DIR/files/` directory
- [ ] Modify `sources/storage/uploadImage.ts`:
  - Replace `s3client.putObject` with conditional: S3 or `fs.writeFile` to local path
  - Replace `resolveImageUrl` to return local file-serving URL when in local mode
- [ ] Add a static file serving route in API for local files (e.g., `/files/*`)

### Task 5: Create CLI entry point with migrate command
- [ ] Create `sources/standalone.ts` as the portable entry point:
  - Parse `process.argv` for subcommands: `migrate`, `serve`
  - `migrate`: initialize PGlite directly, read all `prisma/migrations/*/migration.sql` files in order, execute them via PGlite SQL, track applied migrations
  - `serve`: call existing `main()` logic
  - No args or `--help`: print usage
- [ ] Embed migration SQL files at build time (Bun can import text files)

### Task 6: Add Bun build configuration
- [ ] Add `build:standalone` script to `package.json`: `bun build ./sources/standalone.ts --compile --outfile happy-server`
- [ ] Handle PGlite WASM files: add a post-build step to copy postgres data files next to the binary
- [ ] Test the build: `bun run build:standalone`
- [ ] Test: `./happy-server migrate` creates and migrates a PGlite database
- [ ] Test: `./happy-server serve` starts the server with PGlite

### Task 7: Verify end-to-end
- [ ] Build the binary
- [ ] Run `./happy-server migrate` — verify database is created in `./data/`
- [ ] Run `./happy-server serve` — verify server starts, health endpoint responds
- [ ] Verify no Redis connection attempted
- [ ] Verify files can be stored/served locally

## Technical Details

**PGlite initialization:**
```typescript
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
const pglite = new PGlite(process.env.PGLITE_DIR || './data/pglite');
const adapter = new PrismaPGlite(pglite);
const db = new PrismaClient({ adapter });
```

**Migration approach:**
- Read SQL files from `prisma/migrations/` sorted by directory name (timestamp order)
- Create a `_prisma_migrations` table to track applied migrations
- For each unapplied migration: execute SQL, record in tracking table
- This mirrors what `prisma migrate deploy` does

**Data directory structure:**
```
./data/               (or $DATA_DIR)
  pglite/             # PGlite database files
  files/              # Uploaded files (replaces S3)
    public/users/...  # Same path structure as S3
```

**CLI usage:**
```
happy-server migrate    # Apply database migrations
happy-server serve      # Start the server
```

## Post-Completion
- Document env vars for portable mode (`PGLITE_DIR`, `DATA_DIR`, `HANDY_MASTER_SECRET`)
- Test on Linux for cross-platform binary (Bun cross-compile)
- Consider adding `happy-server init` command for first-time setup
