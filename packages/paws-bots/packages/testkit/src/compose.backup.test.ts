import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { composeBaseArgs, postgresUp } from "./compose-stack.js";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// The suite dumps and restores the developer's running local stack database; run it only with
// explicit opt-in (VERIFY_COMPOSE_BACKUP=1). With the opt-in set, an unreachable stack fails the
// suite instead of skipping it: a silent skip reads as a verified backup.
const describeBackup = process.env.VERIFY_COMPOSE_BACKUP === "1" ? describe : describe.skip;

/** Runs `docker compose` against the repo's stack, with the root env file applied (see above). */
function compose(args: string[], options?: Parameters<typeof execFileSync>[2]) {
  return execFileSync("docker", [...composeBaseArgs(repoRoot), ...args], options);
}

const psql = (sqlArgs: string[]) => ["exec", "-T", "postgres", "psql", "-U", "rakazo", ...sqlArgs];

const SIDE_DATABASE = `rakazo_restore_${randomUUID().replaceAll("-", "")}`;

function createSideDatabase() {
  compose(psql(["-d", "postgres", "-c", `CREATE DATABASE ${SIDE_DATABASE}`]), {
    stdio: "pipe",
    timeout: 20_000,
  });
}

function dropSideDatabase() {
  compose(psql(["-d", "postgres", "-c", `DROP DATABASE ${SIDE_DATABASE}`]), {
    stdio: "pipe",
    timeout: 20_000,
  });
}

/** Mirrors scripts/restore.sh: with ON_ERROR_STOP and a single transaction, any SQL
 * error fails the whole import instead of leaving a partially imported restore. */
function importDump(sql: string) {
  return compose(
    psql(["-d", SIDE_DATABASE, "-X", "--set=ON_ERROR_STOP=on", "--single-transaction", "--file=-"]),
    { input: sql, stdio: ["pipe", "ignore", "ignore"], timeout: 60_000 },
  );
}

describeBackup("compose backup and restore", () => {
  beforeAll(() => {
    if (!postgresUp(repoRoot)) {
      throw new Error(
        "VERIFY_COMPOSE_BACKUP=1 but the local compose stack is not reachable; start it with pnpm compose:up",
      );
    }
  });

  it("dumps postgres and restores into a side database", () => {
    expect(existsSync(path.join(repoRoot, "scripts/backup.sh"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "scripts/restore.sh"))).toBe(true);
    const backups = path.join(repoRoot, "backups");
    mkdirSync(backups, { recursive: true });
    const backupDirectory = mkdtempSync(path.join(backups, "verify-"));
    const stamp = path.basename(backupDirectory);
    // The dump holds the whole database, so it goes even when an assertion fails.
    try {
      execSync(`${path.join(repoRoot, "scripts/backup.sh")} ${stamp}`, {
        stdio: "pipe",
        timeout: 60_000,
        env: { ...process.env, RAKAZO_BACKUP_SKIP_HOMES: "1" },
      });
      const dump = path.join(repoRoot, "backups", stamp, "rakazo.sql");
      expect(existsSync(dump)).toBe(true);
      const sql = readFileSync(dump, "utf8");
      expect(sql).toMatch(/CREATE TABLE|CREATE TABLE IF NOT EXISTS/i);
      expect(sql.toLowerCase()).toContain("bots");
      expect(sql).not.toMatch(/OPENROUTER_API_KEY|sk-or-v1-/);

      compose(
        psql([
          "-d",
          "postgres",
          "-X",
          "--set=ON_ERROR_STOP=on",
          "-c",
          "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN CREATE ROLE rakazo_app NOLOGIN; END IF; END $$",
        ]),
        { stdio: "pipe", timeout: 20_000 },
      );
      createSideDatabase();
      try {
        importDump(sql);
        const tables = compose(psql(["-d", SIDE_DATABASE, "-c", "\\dt"]), {
          encoding: "utf8",
          timeout: 20_000,
        });
        expect(tables).toMatch(/bots/);
      } finally {
        dropSideDatabase();
      }
    } finally {
      rmSync(path.join(repoRoot, "backups", stamp), { recursive: true, force: true });
    }
  }, 90_000);

  it("fails a dump whose data does not import completely", () => {
    createSideDatabase();
    try {
      const broken = [
        "CREATE TABLE bots (id text PRIMARY KEY, name text);",
        "COPY bots (id, name) FROM stdin;",
        "only-one-column",
        "\\.",
        "",
      ].join("\n");
      // psql exits 3 when ON_ERROR_STOP aborts the script; any other failure is not this case.
      let status: number | null | undefined;
      try {
        importDump(broken);
      } catch (error) {
        status = (error as { status?: number | null }).status;
      }
      expect(status).toBe(3);
    } finally {
      dropSideDatabase();
    }
  }, 60_000);
});
