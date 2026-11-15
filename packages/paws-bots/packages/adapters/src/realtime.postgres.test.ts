import { Client, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeListenerClient } from "./realtime.js";
import { PostgresRealtimeFanout } from "./realtime.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("PostgresRealtimeFanout (PostgreSQL contract)", () => {
  it("reconnects a real listener and signals durable catch-up for a missed notification", async () => {
    const pool = new Pool({ connectionString: databaseUrl! });
    // The runtime login cannot create tables, so the owner adds the scratch table.
    const owner = new Pool({
      connectionString: process.env.DATABASE_MIGRATION_URL ?? databaseUrl!,
    });
    const table = `realtime_contract_events_${process.pid}_${Date.now()}`;
    const listenerClients: Client[] = [];
    const signals: string[] = [];
    const seen: string[] = [];
    let cursor = 0;
    let drainError: unknown;
    let draining = Promise.resolve();

    const { rows } = await pool.query<{ role: string }>("SELECT current_user AS role");
    await owner.query(`CREATE TABLE ${table} (id bigserial PRIMARY KEY, body text NOT NULL)`);
    await owner.query(`GRANT SELECT, INSERT ON ${table} TO "${rows[0]!.role}"`);
    await owner.query(`GRANT USAGE ON SEQUENCE ${table}_id_seq TO "${rows[0]!.role}"`);
    const realtime = new PostgresRealtimeFanout({
      connectionString: databaseUrl!,
      publisher: {
        query: async (sql, values) => pool.query(sql, values),
      },
      clientFactory: () => {
        const client = new Client({ connectionString: databaseUrl! });
        listenerClients.push(client);
        return client as RealtimeListenerClient;
      },
      reconnectBaseMs: 100,
      reconnectMaxMs: 100,
      random: () => 0,
    });

    try {
      const unsubscribe = await realtime.subscribe("thread:contract", (signal) => {
        signals.push(signal);
        draining = draining
          .then(async () => {
            const result = await pool.query<{ id: string; body: string }>(
              `SELECT id, body FROM ${table} WHERE id > $1 ORDER BY id`,
              [cursor],
            );
            for (const row of result.rows) {
              cursor = Number(row.id);
              seen.push(row.body);
            }
          })
          .catch((error: unknown) => {
            drainError = error;
          });
      });

      await vi.waitFor(() => expect(signals).toEqual([""]), { timeout: 5_000 });
      const pidResult = await listenerClients[0]!.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const listenerPid = pidResult.rows[0]!.pid;

      await pool.query(`INSERT INTO ${table} (body) VALUES ($1)`, ["notified-event"]);
      await realtime.publish("thread:contract", "durable-event-available");
      await vi.waitFor(() => expect(seen).toEqual(["notified-event"]), { timeout: 5_000 });

      // Commit without a notification before the drop, so only the reconnect's
      // catch-up signal can surface the row, however fast the listener returns.
      await pool.query(`INSERT INTO ${table} (body) VALUES ($1)`, ["missed-notification"]);
      await pool.query("SELECT pg_terminate_backend($1)", [listenerPid]);

      await vi.waitFor(
        () => {
          expect(listenerClients.length).toBeGreaterThanOrEqual(2);
          expect(signals.filter((signal) => signal === "")).toHaveLength(2);
          expect(seen).toEqual(["notified-event", "missed-notification"]);
        },
        { timeout: 10_000, interval: 25 },
      );
      await draining;
      expect(drainError).toBeUndefined();
      expect(signals).toContain("durable-event-available");
      await unsubscribe();
    } finally {
      await realtime.close();
      await owner.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
      await owner.end();
      await pool.end();
    }
  });
});
