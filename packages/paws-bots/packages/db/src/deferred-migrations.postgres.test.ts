import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFERRED_MIGRATION_MARKER,
  deployMigrations,
  heldBackMigrations,
} from "./deferred-migrations.js";

// Creating schemas and running migrations need the owner login.
const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const dbTests = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));

dbTests("deferred migrations", () => {
  const stamp = `${process.pid}_${Date.now()}`;
  const table = `deferred_probe_${stamp}`;
  const added = `29990101000000_add_${stamp}`;
  const dropped = `29990101000001_drop_${stamp}`;
  const broken = `29990101000002_broken_${stamp}`;
  const laterTable = `deferred_later_${stamp}`;
  const laterAdded = `29990101000003_add_${stamp}`;
  const laterDropped = `29990101000004_drop_${stamp}`;
  const lockTable = `deferred_lock_${stamp}`;
  const lockAdded = `29990101000005_lock_${stamp}`;
  const indexAdded = `29990101000006_index_${stamp}`;
  const indexTable = `deferred_index_${stamp}`;
  const rolloutTable = `deferred_rollout_${stamp}`;
  const rolloutAdded = `29990101000007_rollout_add_${stamp}`;
  const rolloutDropped = `29990101000008_rollout_drop_${stamp}`;
  const freshSchema = `deferred_fresh_${stamp}`;
  const dir = mkdtempSync(path.join(tmpdir(), "deferred-migrations-"));
  let client: Client;

  function migration(name: string, sql: string) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, "migration.sql"), sql);
  }

  async function columns(name = table) {
    const { rows } = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY 1",
      [name],
    );
    return rows.map((row) => row.column_name);
  }

  beforeAll(async () => {
    cpSync(path.join(dbPackageDir, "prisma/migrations"), dir, { recursive: true });
    migration(added, `CREATE TABLE "${table}" (id INT, gone INT);\n`);
    migration(dropped, `${DEFERRED_MIGRATION_MARKER}\nALTER TABLE "${table}" DROP COLUMN gone;\n`);
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${freshSchema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.query(`DROP TABLE IF EXISTS "${laterTable}"`);
    await client.query(`DROP TABLE IF EXISTS "${lockTable}"`);
    await client.query(`DROP TABLE IF EXISTS "${indexTable}"`);
    await client.query(`DROP TABLE IF EXISTS "${rolloutTable}"`);
    await client.query("DELETE FROM _prisma_migrations WHERE migration_name = ANY($1)", [
      [
        added,
        dropped,
        broken,
        laterAdded,
        laterDropped,
        lockAdded,
        indexAdded,
        rolloutAdded,
        rolloutDropped,
      ],
    ]);
    await client.query('DELETE FROM "_deferred_migrations" WHERE name = ANY($1)', [
      [dropped, laterDropped, rolloutDropped],
    ]);
    await client.query(`DROP SCHEMA "${freshSchema}"`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds nothing back on a database with no migrations applied", async () => {
    const fresh = new URL(databaseUrl!);
    fresh.searchParams.set("options", `-c search_path=${freshSchema}`);
    await expect(heldBackMigrations(fresh.toString(), dir)).resolves.toEqual([]);
    await expect(heldBackMigrations(fresh.toString(), dir, [])).resolves.toEqual([]);
  });

  it("applies ordinary migrations at once and a deferred drop on the next run", async () => {
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns()).toEqual(["gone", "id"]);
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns()).toEqual(["id"]);
  });

  it("holds a failed rollout's deferred drop until a successful deployment contains it", async () => {
    migration(rolloutAdded, `CREATE TABLE "${rolloutTable}" (id INT, gone INT);\n`);
    migration(
      rolloutDropped,
      `${DEFERRED_MIGRATION_MARKER}\nALTER TABLE "${rolloutTable}" DROP COLUMN gone;\n`,
    );
    const previousMigrations = [added, dropped];
    const input = {
      migrationUrl: databaseUrl!,
      dbPackageDir,
      migrationsDir: dir,
      previousMigrations,
    };
    // B's migrations succeed, but its later health check fails and A remains deployed.
    await deployMigrations(input);
    expect(await columns(rolloutTable)).toEqual(["gone", "id"]);
    // Retrying B or deploying C must still use A's successful migration inventory.
    await deployMigrations(input);
    await deployMigrations(input);
    expect(await columns(rolloutTable)).toEqual(["gone", "id"]);
    await expect(heldBackMigrations(databaseUrl!, dir, [])).resolves.toContain(rolloutDropped);
    // Once B has deployed successfully, the following rollout may apply its deferred drop.
    await deployMigrations({
      ...input,
      previousMigrations: [...previousMigrations, rolloutDropped],
    });
    expect(await columns(rolloutTable)).toEqual(["id"]);
  });

  it("keeps holding a deferred drop back after a failed run", async () => {
    migration(laterAdded, `CREATE TABLE "${laterTable}" (id INT, gone INT);\n`);
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    migration(broken, "SELECT * FROM no_such_table;\n");
    migration(
      laterDropped,
      `${DEFERRED_MIGRATION_MARKER}\nALTER TABLE "${laterTable}" DROP COLUMN gone;\n`,
    );
    await expect(
      deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir }),
    ).rejects.toThrow();

    // Recover the way an operator would: mark the failed migration rolled back and fix it.
    await client.query(
      "UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = $1",
      [broken],
    );
    writeFileSync(path.join(dir, broken, "migration.sql"), "SELECT 1;\n");
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns(laterTable)).toEqual(["gone", "id"]);
    await deployMigrations({ migrationUrl: databaseUrl!, dbPackageDir, migrationsDir: dir });
    expect(await columns(laterTable)).toEqual(["id"]);
  });

  it("retries a migration that lost a lock to a running query", async () => {
    await client.query(`CREATE TABLE "${lockTable}" (id INT)`);
    migration(lockAdded, `ALTER TABLE "${lockTable}" ADD COLUMN extra INT;\n`);
    const reader = new Client({ connectionString: databaseUrl });
    await reader.connect();
    await reader.query("BEGIN");
    await reader.query(`LOCK TABLE "${lockTable}" IN ACCESS SHARE MODE`);
    const released = new Promise((resolve) => setTimeout(resolve, 1_000)).then(async () => {
      await reader.query("COMMIT");
      await reader.end();
    });

    await deployMigrations({
      migrationUrl: databaseUrl!,
      dbPackageDir,
      migrationsDir: dir,
      lockRetryDelaysMs: [2_000],
      lockTimeoutMs: 200,
    });
    await released;
    expect(await columns(lockTable)).toEqual(["extra", "id"]);
  });

  it("lets a concurrent index build wait for open transactions", async () => {
    await client.query(`CREATE TABLE "${indexTable}" (id INT)`);
    migration(
      indexAdded,
      `-- builds without blocking writes\nCREATE INDEX CONCURRENTLY "${indexTable}_id" ON "${indexTable}" (id);\n`,
    );
    // deployMigrations blocks this process while prisma runs, so another process holds the snapshot.
    const reader = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import pg from "pg";
const client = new pg.Client({ connectionString: process.argv[1] });
await client.connect();
await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
await client.query("SELECT 1");
console.log("ready");
await new Promise((resolve) => setTimeout(resolve, 1500));
await client.query("COMMIT");
await client.end();`,
        databaseUrl!,
      ],
      { cwd: dbPackageDir, stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(reader, "exit");
    await once(reader.stdout!, "data");

    const started = Date.now();
    await deployMigrations({
      migrationUrl: databaseUrl!,
      dbPackageDir,
      migrationsDir: dir,
      lockRetryDelaysMs: [],
      lockTimeoutMs: 200,
    });
    expect(Date.now() - started).toBeGreaterThan(1_000);
    expect(await exited).toEqual([0, null]);
    const { rows } = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [
      `${indexTable}_id`,
    ]);
    expect(rows).toHaveLength(1);
  });
});
