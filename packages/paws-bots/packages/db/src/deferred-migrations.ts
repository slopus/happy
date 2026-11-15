import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

/** First line of a migration that may only run once the release before it has stopped. */
export const DEFERRED_MIGRATION_MARKER = "-- deferred";

/** Finished migrations, or undefined on a database no migration run has touched. */
async function appliedMigrations(client: Client): Promise<Set<string> | undefined> {
  const { rows: tables } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists",
  );
  if (!tables[0]?.exists) return undefined;
  const { rows } = await client.query<{ migration_name: string }>(
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
  );
  return new Set(rows.map((row) => row.migration_name));
}

/**
 * Names of `-- deferred` migrations to leave out of this run. Each is held back the first time a
 * migration run sees it and applied on the next, so it lands one release after the code that stops
 * reading what it drops. That keeps the previous release working while the two run side by side,
 * and keeps rolling back one release safe. When supplied, previousMigrations also requires that
 * the last successful deployment contained the migration, so a failed rollout cannot advance it.
 * A database with no applied migrations holds nothing.
 */
export async function heldBackMigrations(
  migrationUrl: string,
  migrationsDir: string,
  previousMigrations?: readonly string[],
): Promise<string[]> {
  const deferred = readdirSync(migrationsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        readFileSync(path.join(migrationsDir, entry.name, "migration.sql"), "utf8").startsWith(
          DEFERRED_MIGRATION_MARKER,
        ),
    )
    .map((entry) => entry.name);
  if (deferred.length === 0) return [];
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const done = await appliedMigrations(client);
    if (!done?.size) return [];
    const pending = deferred.filter((name) => !done.has(name));
    if (pending.length === 0) return [];
    await client.query(
      'CREATE TABLE IF NOT EXISTS "_deferred_migrations" (name TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const { rows: firstSeen } = await client.query<{ name: string }>(
      'INSERT INTO "_deferred_migrations" (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING RETURNING name',
      [pending],
    );
    const held = new Set(firstSeen.map((row) => row.name));
    if (previousMigrations !== undefined) {
      const previous = new Set(previousMigrations);
      for (const name of pending) if (!previous.has(name)) held.add(name);
    }
    return [...held];
  } finally {
    await client.end();
  }
}

async function forgetHeldBack(migrationUrl: string, names: string[]) {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    await client.query('DELETE FROM "_deferred_migrations" WHERE name = ANY($1)', [names]);
  } finally {
    await client.end();
  }
}

const BUILDS_INDEX_CONCURRENTLY = /\bCONCURRENTLY\b/i;
const SQL_COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;
const LOCK_TIMEOUT_MS = 5_000;

/**
 * Whether a migration this run applies builds an index concurrently. Such a build waits for every
 * open transaction to finish, which a lock timeout would cancel.
 */
async function buildsIndexConcurrently(migrationUrl: string, migrationsPath: string) {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const done = (await appliedMigrations(client)) ?? new Set<string>();
    return readdirSync(migrationsPath, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() &&
        !done.has(entry.name) &&
        BUILDS_INDEX_CONCURRENTLY.test(
          readFileSync(path.join(migrationsPath, entry.name, "migration.sql"), "utf8").replace(
            SQL_COMMENTS,
            "",
          ),
        ),
    );
  } finally {
    await client.end();
  }
}

/** A migration waiting on a lock queues every later query on that table behind it. */
function withLockTimeout(url: string, ms: number) {
  const parsed = new URL(url);
  const options = [parsed.searchParams.get("options"), `-c lock_timeout=${ms}`];
  parsed.searchParams.set("options", options.filter(Boolean).join(" "));
  return parsed.toString();
}

const LOCK_CONFLICT = /\b(40P01|55P03)\b/;
const NOT_ONE_TRANSACTION = /\b(CONCURRENTLY|COMMIT)\b/i;
const LOCK_RETRY_DELAYS_MS = [2_000, 10_000];

/**
 * Marks the failed migration rolled back when it lost a lock to live traffic (a deadlock or lock
 * timeout) and ran as one transaction, so nothing of it stayed applied and running it again is safe.
 */
async function rollBackLockConflict(migrationUrl: string, migrationsPath: string) {
  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      migration_name: string;
      logs: string | null;
    }>(
      "SELECT id, migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL",
    );
    const failed = rows.length === 1 ? rows[0]! : undefined;
    if (!failed || !LOCK_CONFLICT.test(failed.logs ?? "")) return undefined;
    const sql = readFileSync(
      path.join(migrationsPath, failed.migration_name, "migration.sql"),
      "utf8",
    );
    if (NOT_ONE_TRANSACTION.test(sql)) return undefined;
    await client.query(
      "UPDATE _prisma_migrations SET rolled_back_at = now() WHERE id = $1 AND finished_at IS NULL AND rolled_back_at IS NULL",
      [failed.id],
    );
    return failed.migration_name;
  } finally {
    await client.end();
  }
}

/** The database package's own Prisma CLI, run by this runtime so no package manager is needed. */
function prismaCli(dbPackageDir: string) {
  const manifest = createRequire(path.join(dbPackageDir, "package.json")).resolve(
    "prisma/package.json",
  );
  return path.join(path.dirname(manifest), "build/index.js");
}

/**
 * `prisma migrate deploy` from the database package, without the migrations held back this run.
 * A migration gives up on a lock the running release holds after a short wait, instead of stalling
 * live queries behind it, and is retried after a pause.
 */
export async function deployMigrations(input: {
  migrationUrl: string;
  dbPackageDir: string;
  migrationsDir?: string;
  lockRetryDelaysMs?: number[];
  lockTimeoutMs?: number;
  previousMigrations?: readonly string[];
}) {
  const migrationsDir = input.migrationsDir ?? path.join(input.dbPackageDir, "prisma/migrations");
  const held = await heldBackMigrations(
    input.migrationUrl,
    migrationsDir,
    input.previousMigrations,
  );
  let migrationsPath = migrationsDir;
  if (held.length) {
    migrationsPath = mkdtempSync(path.join(tmpdir(), "rakazo-migrations-"));
    cpSync(migrationsDir, migrationsPath, {
      recursive: true,
      filter: (source) => !held.includes(path.relative(migrationsDir, source).split(path.sep)[0]!),
    });
    process.stdout.write(`Holding back until the next migration run: ${held.join(", ")}\n`);
  }
  try {
    const deployUrl = (await buildsIndexConcurrently(input.migrationUrl, migrationsPath))
      ? input.migrationUrl
      : withLockTimeout(input.migrationUrl, input.lockTimeoutMs ?? LOCK_TIMEOUT_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        execFileSync(process.execPath, [prismaCli(input.dbPackageDir), "migrate", "deploy"], {
          cwd: input.dbPackageDir,
          stdio: "inherit",
          env: {
            ...process.env,
            DATABASE_MIGRATION_URL: deployUrl,
            RAKAZO_MIGRATIONS_PATH: migrationsPath,
          },
        });
        break;
      } catch (error) {
        const delay = (input.lockRetryDelaysMs ?? LOCK_RETRY_DELAYS_MS)[attempt];
        const retried =
          delay === undefined
            ? undefined
            : await rollBackLockConflict(input.migrationUrl, migrationsPath).catch(() => undefined);
        if (!retried) throw error;
        process.stdout.write(`${retried} lost a lock to running queries; retrying\n`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (error) {
    // A failed run may leave the previous release running, so the hold lasts until a run succeeds.
    if (held.length) await forgetHeldBack(input.migrationUrl, held);
    throw error;
  } finally {
    if (migrationsPath !== migrationsDir) rmSync(migrationsPath, { recursive: true, force: true });
  }
}
