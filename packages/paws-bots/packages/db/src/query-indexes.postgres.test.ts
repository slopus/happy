import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;
const postgres = enabled ? describe : describe.skip;

// Hot reads, each pinned to the index that serves it in production.
// Sequential scans are disabled so the planner must reach for an index on a small test table.
const hotQueries = [
  {
    name: "a run's bot replies",
    index: "messages_runId_seq_idx",
    sql: `SELECT id FROM messages WHERE "runId" = $1 AND role = 'bot' ORDER BY seq`,
  },
  {
    name: "a task's runs (delete cascade)",
    index: "runs_taskId_idx",
    sql: `SELECT id FROM runs WHERE "taskId" = $1`,
  },
  {
    name: "a bot's run lease fence",
    index: "runs_botId_createdAt_idx",
    sql: `SELECT max("leaseFence") FROM runs WHERE "botId" = $1`,
  },
  {
    name: "live execution leases for woken bots",
    index: "computer_execution_leases_botId_expiresAt_idx",
    sql: `SELECT "computerId" FROM computer_execution_leases WHERE "botId" = ANY(ARRAY[$1]) AND "expiresAt" > now()`,
  },
  {
    name: "bot-message outcomes still to return",
    index: "runs_bot_outcome_pending_idx",
    sql: `SELECT id FROM runs WHERE trigger = 'bot_message' AND "botOutcomeReturnedAt" IS NULL
      AND (status IN ('completed', 'failed') OR (status = 'cancelled' AND error = $1))
      ORDER BY "updatedAt", id LIMIT 100`,
  },
  {
    name: "background-helper outcomes still to return",
    index: "runs_helper_outcome_pending_idx",
    sql: `SELECT id FROM runs WHERE trigger = 'helper' AND "botOutcomeReturnedAt" IS NULL
      AND status IN ('completed', 'failed', 'cancelled') AND id <> $1
      ORDER BY "updatedAt", id LIMIT 100`,
  },
  {
    name: "a bot thread's latest run",
    index: "runs_threadId_createdAt_id_idx",
    sql: `SELECT id FROM runs WHERE "threadId" = $1 AND trigger NOT IN ('bot_message', 'tickets')
      ORDER BY "createdAt" DESC, id DESC LIMIT 1`,
  },
  {
    name: "a user's latest finished run in a Space",
    index: "runs_recent_activity_idx",
    sql: `SELECT "completedAt" FROM runs WHERE "spaceId" = $1 AND "userId" = $1
      AND status IN ('completed', 'failed', 'cancelled')
      AND trigger NOT IN ('tickets', 'helper', 'helper_result')
      AND "completedAt" IS NOT NULL ORDER BY "completedAt" DESC LIMIT 1`,
  },
  {
    name: "a thread's messages after a cursor",
    index: "messages_threadId_seq_key",
    sql: `SELECT id FROM messages WHERE "threadId" = $1 AND seq > 0 ORDER BY seq LIMIT 100`,
  },
  {
    name: "a thread's events after a cursor",
    index: "events_threadId_seq_key",
    sql: `SELECT id FROM events WHERE "threadId" = $1 AND seq > 0 ORDER BY seq LIMIT 100`,
  },
];

postgres("hot query indexes (PostgreSQL)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it.each(hotQueries)("reads $name through $index", async ({ index, sql }) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, ["missing-id"]);
      expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(index);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
