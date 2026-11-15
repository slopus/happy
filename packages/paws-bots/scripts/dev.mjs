#!/usr/bin/env node
// `pnpm dev`: start the API, worker, web app, and sandbox supervisor for this checkout.
//
// Several checkouts (git worktrees) can run at once. Each gets the first free block of ports,
// and all of them share one Postgres database unless this branch adds migrations that main
// does not have; those run against a database of the branch's own on the same server, so
// unmerged schema changes never reach the shared one.
//
// The database is `.env`'s DATABASE_URL when it is set: it must accept a
// connection, or startup fails rather than falling back to a different one.
// With no DATABASE_URL, a local Postgres container (`rakazo-dev-postgres`) is
// started and reused by every checkout.
// Setting WEB_PORT or API_PORT, in the shell or `.env`, turns off port selection. A relative
// DATA_DIR resolves in the main checkout, so checkouts sharing the database share its files.
// Branch databases, and their copied files, are dropped once the branch is deleted or merged.
//
// RAKAZO_DEV_TAILNET=1 also serves the web app over HTTPS to your other Tailscale devices, at
// https://<this machine>.<tailnet>.ts.net:<web port>. Everything still listens on loopback; the
// Tailscale daemon forwards to it, so only devices signed in to your tailnet can reach it.
import { execFileSync, spawn } from "node:child_process";
import {
  constants,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRANCH_DATABASE_COMMENT,
  branchDatabaseName,
  branchDatabaseOwner,
} from "./dev-branch-databases.ts";
import { runPnpm, spawnPnpm } from "./pnpm.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackage = path.join(root, "packages/db");
const require = createRequire(path.join(dbPackage, "package.json"));
const { Client } = require("pg");
const dotenv = require("dotenv");

const DEFAULT_PORTS = { web: 5173, api: 3100, supervisor: 7091 };
const PORT_STEP = 10;
const MANAGED = {
  container: "rakazo-dev-postgres",
  image: "postgres:18",
  port: 54318,
  owner: "rakazo",
  runtime: "rakazo_dev",
  database: "rakazo",
};
const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const SERVICES = ["@rakazo/api", "@rakazo/worker", "@rakazo/web", "@rakazo/sandbox-supervisor"];

const fileEnv = existsSync(path.join(root, ".env"))
  ? dotenv.parse(readFileSync(path.join(root, ".env")))
  : {};
const setting = (name) => process.env[name] ?? fileEnv[name];
const log = (message) => process.stdout.write(`[dev] ${message}\n`);

// A command that runs another with secrets added to its environment, such as a secrets manager's
// `run --`. Values it adds win over `.env`.
const runWith = setting("RAKAZO_DEV_RUN_WITH")?.trim();
if (runWith && !setting("RAKAZO_DEV_RUNNING_WITH")) {
  const [command, ...args] = runWith.split(/\s+/);
  const self = [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)];
  const wrapper = spawn(command, [...args, ...self], {
    stdio: "inherit",
    env: { ...process.env, RAKAZO_DEV_RUNNING_WITH: "1" },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => wrapper.kill(signal));
  const [code, signal] = await new Promise((resolve, reject) => {
    wrapper.once("error", (error) =>
      reject(new Error(`RAKAZO_DEV_RUN_WITH could not start ${command}`, { cause: error })),
    );
    wrapper.once("exit", (...outcome) => resolve(outcome));
  });
  if (!signal) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
  await new Promise(() => {});
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options }).trim();
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function choosePorts() {
  for (let block = 0; block < 50; block += 1) {
    const ports = Object.fromEntries(
      Object.entries(DEFAULT_PORTS).map(([name, port]) => [name, port + block * PORT_STEP]),
    );
    const free = await Promise.all(Object.values(ports).map(portFree));
    if (free.every(Boolean)) return ports;
  }
  throw new Error("No free port block found near the defaults. Set WEB_PORT and API_PORT in .env.");
}

function portEnv({ web, api, supervisor }) {
  const webUrl = `http://127.0.0.1:${web}`;
  const apiUrl = `http://127.0.0.1:${api}`;
  return {
    WEB_PORT: String(web),
    WEB_ORIGIN: webUrl,
    BETTER_AUTH_URL: webUrl,
    API_PORT: String(api),
    API_URL: apiUrl,
    API_PROXY_TARGET: apiUrl,
    SUPERVISOR_PORT: String(supervisor),
    SANDBOX_SUPERVISOR_URL: `http://127.0.0.1:${supervisor}`,
  };
}

async function connects(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function startManagedPostgres() {
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
  } catch {
    throw new Error("No DATABASE_URL in .env and Docker is not running to start a local Postgres.");
  }
  const state = (() => {
    try {
      return run("docker", ["inspect", "--format", "{{.State.Running}}", MANAGED.container]);
    } catch {
      return null;
    }
  })();
  if (state === null) {
    log(`Starting a shared Postgres container (${MANAGED.container})`);
    run("docker", [
      "run",
      "-d",
      "--name",
      MANAGED.container,
      "--restart",
      "unless-stopped",
      "-e",
      `POSTGRES_USER=${MANAGED.owner}`,
      // Development only: the container is published on loopback and holds throwaway data.
      "-e",
      `POSTGRES_PASSWORD=${MANAGED.owner}`,
      "-e",
      `POSTGRES_DB=${MANAGED.database}`,
      "-p",
      `127.0.0.1:${MANAGED.port}:5432`,
      "-v",
      `${MANAGED.container}:/var/lib/postgresql`,
      MANAGED.image,
    ]);
  } else if (state !== "true") {
    run("docker", ["start", MANAGED.container]);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      run("docker", ["exec", MANAGED.container, "pg_isready", "-q", "-U", MANAGED.owner]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const server = `127.0.0.1:${MANAGED.port}`;
  return {
    url: `postgres://${MANAGED.runtime}:${MANAGED.runtime}@${server}/${MANAGED.database}`,
    migrationUrl: `postgres://${MANAGED.owner}:${MANAGED.owner}@${server}/${MANAGED.database}`,
  };
}

async function sharedDatabase() {
  const url = setting("DATABASE_URL");
  const migrationUrl = setting("DATABASE_MIGRATION_URL") || url;
  if (url) {
    if (await connects(migrationUrl)) return { url, migrationUrl };
    // A fallback would silently give this checkout different data than configured.
    throw new Error(
      "The configured database does not accept a connection. Check DATABASE_MIGRATION_URL or DATABASE_URL, or remove DATABASE_URL to use the local container.",
    );
  }
  return startManagedPostgres();
}

function migrationNames(ref) {
  return new Set(
    run("git", ["ls-tree", "--name-only", ref, "packages/db/prisma/migrations/"], { cwd: root })
      .split("\n")
      .filter(Boolean)
      .map((entry) => path.basename(entry)),
  );
}

function mainMigrations() {
  try {
    return migrationNames("origin/main");
  } catch {
    // Without main to compare against, any migration may be unmerged.
    throw new Error("Could not read origin/main. Run `git fetch origin main` and try again.");
  }
}

/** Migration folders in a checkout's working tree, committed or not. */
function checkoutMigrations(checkout) {
  const dir = path.join(checkout, "packages/db/prisma/migrations");
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isDirectory()));
}

/** Migrations in this checkout that origin/main does not have. */
function branchOnlyMigrations(onMain) {
  return [...checkoutMigrations(root)].filter((name) => !onMain.has(name));
}

/** A branch's migrations: its worktree's files when it is checked out, else its commits. */
function branchMigrations(branch) {
  const worktrees = run("git", ["worktree", "list", "--porcelain"], { cwd: root }).split("\n\n");
  for (const entry of worktrees) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) {
      return checkoutMigrations(lines[0].replace(/^worktree /, ""));
    }
  }
  try {
    return migrationNames(`refs/heads/${branch}`);
  } catch {
    return new Set(); // Deleted.
  }
}

// Marks a finished branch database and records which repository and branch own it.
function branchDatabaseComment(branch) {
  return BRANCH_DATABASE_COMMENT + JSON.stringify({ repo: repositoryId(), branch });
}

function repositoryId() {
  return path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root }));
}

function currentBranch() {
  return run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
}

/** A branch database's files, kept apart so deleting one never removes a file main still uses. */
function branchDataDir(sharedDataDir, name) {
  return path.join(path.dirname(sharedDataDir), ".rakazo-dev-branches", name, "data");
}

async function branchDatabase(shared, sharedDataDir) {
  const sharedName = new URL(shared.migrationUrl).pathname.slice(1);
  const branch = currentBranch();
  const name = branchDatabaseName(sharedName, branch);
  const dataDir = branchDataDir(sharedDataDir, name);
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    // Two starts of the same branch take turns; the lock ends with this connection.
    await owner.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
    const existing = await owner.query(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [name],
    );
    if (existing.rowCount && existing.rows[0].comment)
      return branchConnection(shared, name, dataDir);
    // No comment means an earlier start stopped partway; begin again.
    if (existing.rowCount) await owner.query(`DROP DATABASE ${owner.escapeIdentifier(name)}`);
    rmSync(path.dirname(dataDir), { recursive: true, force: true });
    let copied = true;
    try {
      // A copy keeps your accounts and bots; it needs no open connections to the source.
      await owner.query(
        `CREATE DATABASE ${owner.escapeIdentifier(name)} TEMPLATE ${owner.escapeIdentifier(sharedName)}`,
      );
    } catch {
      copied = false;
      await owner.query(`CREATE DATABASE ${owner.escapeIdentifier(name)}`);
    }
    try {
      if (copied && existsSync(sharedDataDir)) {
        // Copy-on-write where the filesystem supports it, so this is cheap even for large homes.
        cpSync(sharedDataDir, dataDir, { recursive: true, mode: constants.COPYFILE_FICLONE });
      }
    } catch (error) {
      await owner.query(`DROP DATABASE ${owner.escapeIdentifier(name)}`);
      rmSync(path.dirname(dataDir), { recursive: true, force: true });
      throw new Error(`Could not copy ${sharedDataDir} for ${name}`, { cause: error });
    }
    await owner.query(
      `COMMENT ON DATABASE ${owner.escapeIdentifier(name)} IS ${owner.escapeLiteral(branchDatabaseComment(branch))}`,
    );
    log(
      copied
        ? `Copied the shared database and files to ${name}`
        : `Created an empty ${name} (the shared one was in use, so it could not be copied)`,
    );
  } finally {
    await owner.end();
  }
  return branchConnection(shared, name, dataDir);
}

function branchConnection(shared, name, dataDir) {
  return {
    url: withDatabase(shared.url, name),
    migrationUrl: withDatabase(shared.migrationUrl, name),
    dataDir,
  };
}

/**
 * Drop this repository's branch databases that nothing needs anymore: the branch was deleted, or
 * main now has all of its migrations, counting uncommitted ones in a branch's worktree. `keep`, the
 * branch about to start, and any database another checkout still has open are left alone.
 */
async function pruneBranchDatabases(shared, sharedDataDir, onMain, keep) {
  const owner = new Client({ connectionString: shared.migrationUrl });
  await owner.connect();
  try {
    const { rows } = await owner.query(
      `SELECT d.datname AS name, substr(c.description, $2) AS owner
         FROM pg_database d JOIN pg_shdescription c ON c.objoid = d.oid
        WHERE c.description LIKE $1 || '%'`,
      [BRANCH_DATABASE_COMMENT, BRANCH_DATABASE_COMMENT.length + 1],
    );
    const repo = repositoryId();
    const sharedName = new URL(shared.migrationUrl).pathname.slice(1);
    for (const row of rows) {
      const branch = branchDatabaseOwner(row, sharedName, repo);
      if (branch === undefined) continue;
      if (branch === keep) continue;
      if ([...branchMigrations(branch)].some((name) => !onMain.has(name))) continue;
      try {
        await owner.query(`DROP DATABASE ${owner.escapeIdentifier(row.name)}`);
        rmSync(path.dirname(branchDataDir(sharedDataDir, row.name)), {
          recursive: true,
          force: true,
        });
        log(`Removed ${row.name}; ${branch} no longer needs its own database`);
      } catch {
        // Still in use by a running checkout.
      }
    }
  } finally {
    await owner.end();
  }
}

function tailscaleCli() {
  for (const cli of ["tailscale", TAILSCALE_APP_CLI]) {
    try {
      run(cli, ["version"]);
      return cli;
    } catch {}
  }
  throw new Error("RAKAZO_DEV_TAILNET is set, but the tailscale CLI was not found.");
}

/** Serve the loopback web port to the tailnet over HTTPS on the same port number. */
function shareOnTailnet(webPort) {
  const cli = tailscaleCli();
  const host = JSON.parse(run(cli, ["status", "--json"])).Self?.DNSName?.replace(/\.$/, "");
  if (!host) throw new Error("Tailscale is not connected. Sign in to Tailscale and try again.");
  // Inherit stdio: the first run may print a link to turn on HTTPS for the tailnet and wait.
  execFileSync(cli, ["serve", "--bg", `--https=${webPort}`, `http://127.0.0.1:${webPort}`], {
    stdio: "inherit",
  });
  return {
    host,
    origin: `https://${host}:${webPort}`,
    stop() {
      try {
        run(cli, ["serve", `--https=${webPort}`, "off"]);
      } catch {
        log(`Could not stop sharing port ${webPort}; run: tailscale serve --https=${webPort} off`);
      }
    },
  };
}

function generateClientIfStale(env) {
  const client = path.join(dbPackage, "src/generated/prisma/client.ts");
  const schema = path.join(dbPackage, "prisma/schema.prisma");
  if (existsSync(client) && statSync(client).mtimeMs >= statSync(schema).mtimeMs) return;
  log("Generating the Prisma client");
  runPnpm(["--filter", "@rakazo/db", "generate"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

let ports = null;
if (!setting("WEB_PORT") && !setting("API_PORT")) {
  ports = await choosePorts();
  Object.assign(env, portEnv(ports));
}

// Checkouts that share a database also share its job queue, so any checkout's worker may write a
// file another checkout's API reads. A relative DATA_DIR resolves in the main checkout for all.
const mainCheckout = path.dirname(
  path.resolve(root, run("git", ["rev-parse", "--git-common-dir"], { cwd: root })),
);
const sharedDataDir = path.resolve(mainCheckout, setting("DATA_DIR") || "./data");

const shared = { ...(await sharedDatabase()), dataDir: sharedDataDir };
let database = shared;
const onMain = mainMigrations();
const pending = branchOnlyMigrations(onMain);
await pruneBranchDatabases(shared, sharedDataDir, onMain, pending.length ? currentBranch() : null);
if (pending.length) {
  log(`This branch adds ${pending.length} migration(s), so it gets its own database`);
  database = await branchDatabase(shared, sharedDataDir);
}
env.DATABASE_URL = database.url;
env.DATABASE_MIGRATION_URL = database.migrationUrl;
env.DATA_DIR = database.dataDir;

generateClientIfStale(env);
// Checkouts starting together would otherwise grant the server-wide runtime role at the same
// moment and fail. Advisory locks are per database, so every checkout locks the shared one.
const migrationLock = new Client({ connectionString: shared.migrationUrl });
await migrationLock.connect();
try {
  await migrationLock.query("SELECT pg_advisory_lock(hashtext('rakazo dev migrate'))");
  runPnpm(["db:migrate"], { cwd: root, env, stdio: "inherit" });
} finally {
  await migrationLock.end();
}

let tailnet = null;
if (/^(1|true)$/i.test(setting("RAKAZO_DEV_TAILNET") ?? "")) {
  // The emulator's inbox has no sign-in check; it is safe only while nothing but this machine
  // can reach the web server.
  if (setting("EMAIL_EMULATOR") === "true") {
    throw new Error("RAKAZO_DEV_TAILNET cannot be used with EMAIL_EMULATOR=true.");
  }
  tailnet = shareOnTailnet(Number(env.WEB_PORT ?? setting("WEB_PORT") ?? 5173));
  // Every way this process ends, including a failed launch, turns sharing off.
  process.on("exit", () => tailnet.stop());
  // Sign-in cookies and links follow this origin, so use the tailnet URL on this machine too.
  env.WEB_ORIGIN = tailnet.origin;
  env.BETTER_AUTH_URL = tailnet.origin;
  env.RAKAZO_ALLOWED_HOSTS = [setting("RAKAZO_ALLOWED_HOSTS"), tailnet.host]
    .filter(Boolean)
    .join(",");
}

if (tailnet) log(`Open ${tailnet.origin} from any device on your tailnet`);
else if (ports) log(`Open http://127.0.0.1:${ports.web}`);
const turbo = spawnPnpm(
  ["exec", "turbo", "dev", "--env-mode=loose", ...SERVICES.map((name) => `--filter=${name}`)],
  { cwd: root, env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => turbo.kill(signal));
turbo.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
