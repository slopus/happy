# Electric SQL — Sync Engine Evaluation

Research completed 2026-04-08.

## What it is

Electric SQL is a **read-path sync engine** — a standalone Elixir service
that sits between Postgres and client applications. It tails the Postgres
WAL (Write-Ahead Log) and streams subsets of data ("Shapes") to clients
over HTTP.

It is NOT a database, NOT a Postgres extension, NOT a write-path solution.

```
Postgres ──[logical replication]──> Electric (Elixir) ──[HTTP]──> CDN ──> Clients
```

## Open source

- **License**: Apache-2.0
- **Repo**: github.com/electric-sql/electric
- **Stars**: ~10,046
- **NPM downloads**: ~1.68M/month (`@electric-sql/client`)
- **Maintained by**: Electric DB Inc.
- **Status**: GA (1.0 released March 2025, currently 1.1+)
- **Commercial offering**: Electric Cloud (hosted, pay for writes + retention,
  reads/fan-out free)

## Core API

### Server setup (Docker)

```yaml
electric:
  image: electricsql/electric:latest
  environment:
    DATABASE_URL: postgresql://user:pass@host:5432/db
    ELECTRIC_SECRET: your-secret
  ports:
    - "3000:3000"
```

Requires: Postgres 14+, `wal_level=logical`, user with `REPLICATION` role.

Electric creates in your database:
- Publication: `electric_publication_default`
- Replication slot: `electric_slot_default`
- Sets `REPLICA IDENTITY FULL` on synced tables
- No extensions required

### Client — React hooks

```tsx
import { useShape } from '@electric-sql/react'

function TaskList() {
  const { isLoading, data } = useShape<Task>({
    url: `http://localhost:3000/v1/shape`,
    params: {
      table: 'tasks',
      where: `org_id = '123'`,
      columns: `id,title,status`,
    },
  })

  if (isLoading) return <div>Loading...</div>
  return <ul>{data.map(t => <li key={t.id}>{t.title}</li>)}</ul>
}
```

### Client — vanilla TypeScript

```ts
import { ShapeStream, Shape } from '@electric-sql/client'

const stream = new ShapeStream({
  url: `http://localhost:3000/v1/shape`,
  params: {
    table: 'tasks',
    where: `org_id = '123'`,
  },
})

const shape = new Shape(stream)
const rows = await shape.rows  // wait for initial sync

shape.subscribe(({ rows }) => {
  console.log('Updated:', rows)
})
```

### Raw HTTP API

```sh
# Initial sync — returns all matching rows
curl 'http://localhost:3000/v1/shape?table=tasks&offset=-1'

# Live updates — long-polls until new data arrives
curl 'http://localhost:3000/v1/shape?table=tasks&live=true&handle=abc&offset=0_5'

# SSE mode
curl 'http://localhost:3000/v1/shape?table=tasks&live=true&live_sse=true&handle=abc&offset=0_5'

# Changes only (skip initial snapshot)
curl 'http://localhost:3000/v1/shape?table=tasks&offset=-1&log=changes_only'
```

Response format:
```json
[
  {"offset":"0_0","value":{"id":"1","title":"Fix bug"},"key":"\"public\".\"tasks\"/\"1\"","headers":{"operation":"insert"}},
  {"headers":{"control":"up-to-date"}}
]
```

### Writes — BYO (by design)

Electric does NOT handle writes. You write through your own API:

```
Client → tRPC/REST mutation → your backend → Postgres INSERT
    → WAL → Electric → shape stream → all subscribers get the update
```

With TanStack DB, optimistic updates work via txid confirmation:
```ts
const collection = createCollection(
  electricCollectionOptions<Task>({
    shapeOptions: { url, params: { table: 'tasks' } },
    getKey: (item) => item.id,
    onInsert: async ({ transaction }) => {
      const result = await apiClient.task.create.mutate(item)
      return { txid: result.txid }  // confirms optimistic write
    },
  }),
)
```

## Shapes — capabilities and limitations

A Shape is a declarative subset of one Postgres table.

**Can do:**
- Single table with WHERE filter, column selection
- SQL operators, boolean logic, LIKE, IN, comparisons
- Parameterized queries (`$1`, `$2`) for injection safety
- Subqueries (experimental): `id IN (SELECT user_id FROM memberships WHERE org_id = $1)`
- Progressive loading with ORDER BY, LIMIT, OFFSET
- Partitioned tables

**Cannot do:**
- No JOINs (single-table only — subscribe to multiple shapes, join client-side)
- No aggregations (COUNT, SUM, AVG)
- No non-deterministic functions (now(), random()) in WHERE
- Shapes are immutable — switch context = new subscription

## How sync works under the hood

1. Electric connects to Postgres via **logical replication** (standard PG
   feature used for standby replicas)
2. Creates a publication and replication slot
3. `ShapeLogCollector` GenServer consumes WAL stream, evaluates each
   INSERT/UPDATE/DELETE against registered shapes' WHERE clauses
4. Matching changes are distributed to shape-specific logs
5. Clients consume via HTTP long-polling or SSE
6. `up-to-date` control message = caught up to current state
7. `must-refetch` = server needs client to re-sync from scratch

**Consistency**: changes delivered in WAL (LSN) order within a shape.
Eventually consistent. No gaps.

**No conflict resolution**: Electric is read-only. Conflicts only exist
in your write path — your problem to solve.

## Performance

| Metric | Value |
|--------|-------|
| Live update latency (optimized WHERE) | **6ms** (3ms PG + 3ms Electric) |
| Live update latency (non-optimized WHERE) | ~100ms at 10K shapes |
| Write throughput | **4,000–6,000 rows/sec** |
| Initial sync | CDN-cacheable at edge |
| Concurrent clients tested | 2K clients × 500-row shapes |
| Single client max | 1M rows with linear sync time |
| Production scale | 100K–1M concurrent users |

**CDN caching is the scaling secret**: initial sync responses are HTTP-cacheable.
Live-mode long-polling requests are collapsed by CDN (N clients waiting =
1 upstream request). This means Electric + CDN scales to millions with
minimal Postgres load.

## Frontend integration

| Framework | Package | Status |
|-----------|---------|--------|
| React | `@electric-sql/react` | First-class |
| React Native / Expo | `@electric-sql/react` | Works (same client) |
| TanStack DB | `@tanstack/electric-db-collection` | Deep integration |
| Next.js | Via `@electric-sql/react` | Integration guide |
| Phoenix/LiveView | `phoenix_sync` | First-class (Elixir) |
| Yjs | `y-electric` | Integration package |
| Any language | HTTP + JSON | Roll your own |

Note: PGlite does NOT yet work in React Native.

## Recommended stack (what Superset uses)

```
Reads:  Postgres → Electric → Cloudflare Worker (auth proxy) → TanStack DB
Writes: Client → tRPC mutation → API server → Postgres → Electric confirms
```

This is the officially recommended "TanStack" stack in Electric's docs.
Superset validates it works in production at scale.

## Comparison to alternatives

| | Electric | Custom WS | Supabase Realtime | PowerSync | CRDTs |
|---|---|---|---|---|---|
| Protocol | HTTP (CDN-cacheable) | WS (stateful) | WS | Custom | P2P |
| Initial sync | Built-in + cached | Build yourself | Separate query | Built-in | Built-in |
| Writes | BYO | Full control | Built-in | Built-in (sync rules) | Automatic |
| Scaling | CDN fan-out | Connection-bound | Connection-bound | Medium | P2P |
| Conflicts | BYO | BYO | N/A | Built-in | Automatic (math) |
| Best for | Structured data sync | Full control | Notifications | Mobile offline | Collaborative editing |
| Complexity | Low | High | Medium | Medium | High |

## Relevance for Happy

**Strong fit:**
- Read-heavy pattern (streaming agent state to UI) maps perfectly
- CDN caching scales without Postgres load
- 6ms latency for live agent activity updates
- HTTP works everywhere (web, mobile, CLI)
- Postgres stays source of truth with full SQL power
- Expo/React Native support

**Concerns:**
- No joins — need multiple shapes + client-side joining
- Must build own write path (fine — agent commands go through backend anyway)
- One more service to operate (or use Electric Cloud)
- Shapes are immutable (session switch = new subscription)
