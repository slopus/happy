import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { CDPSession } from "@playwright/test";
import { abortableDelay } from "@rakazo/core";
import { createPool } from "@rakazo/db";
import { disposableDatabaseEnv, startPostgres } from "./postgres.js";

export const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

/**
 * The offline API and web settings both performance benchmarks run with: scripted agent, fake
 * computers, no provider keys, analytics, or telemetry.
 */
export function benchmarkEnvironment(options: {
  databaseUrl: string;
  webPort: number;
  apiPort: number;
  dataDir: string;
}): NodeJS.ProcessEnv {
  const webOrigin = `http://127.0.0.1:${options.webPort}`;
  const apiOrigin = `http://127.0.0.1:${options.apiPort}`;
  return {
    ...process.env,
    NODE_ENV: "production",
    ...disposableDatabaseEnv(options.databaseUrl),
    VERIFY_DATABASE: "1",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    CLOUD_AGENT_PROVIDER: "emulator",
    RAKAZO_LIVE_MODEL_CATALOG: "off",
    ANALYTICS_PROVIDER: "none",
    LOG_LEVEL: "off",
    COMPOSIO_API_KEY: "",
    OPENROUTER_API_KEY: "",
    E2B_API_KEY: "",
    DAYTONA_API_KEY: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    STRIPE_PRICE_ID: "",
    SENTRY_DSN: "",
    SENTRY_BROWSER_DSN: "",
    BETTER_AUTH_SECRET: "rakazo-benchmark-auth-secret-over-32-characters",
    ENCRYPTION_KEY: "rakazo-benchmark-encryption-key-over-32-characters",
    SANDBOX_SUPERVISOR_TOKEN: "rakazo-benchmark-supervisor-token-over-32-characters",
    SCREEN_PROXY_SECRET: "rakazo-benchmark-screen-proxy-secret-over-32-characters",
    BETTER_AUTH_URL: webOrigin,
    WEB_ORIGIN: webOrigin,
    API_PORT: String(options.apiPort),
    API_URL: apiOrigin,
    API_PROXY_TARGET: apiOrigin,
    WEB_PORT: String(options.webPort),
    RAKAZO_HOST: "127.0.0.1",
    RAKAZO_WEB_URL: webOrigin,
    DATA_DIR: options.dataDir,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    PUBLIC_POSTHOG_KEY: "",
    CI: "",
  };
}

/**
 * A database only this run uses. Given a server URL, a fresh database on it that is dropped
 * afterwards; otherwise a disposable Postgres container.
 */
export async function startBenchmarkDatabase(serverUrl: string | undefined) {
  if (!serverUrl) {
    const container = await startPostgres();
    return { url: container.getConnectionUri(), stop: () => container.stop().then(() => {}) };
  }
  const admin = new URL(serverUrl);
  const url = new URL(serverUrl);
  const name = `rakazo_bench_${randomUUID().replaceAll("-", "")}`;
  url.pathname = `/${name}`;
  await adminQuery(admin.href, `CREATE DATABASE "${name}"`);
  return {
    url: url.href,
    stop: () => adminQuery(admin.href, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  };
}

async function adminQuery(url: string, sql: string) {
  const pool = createPool(url);
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

export function migrateDatabase(env: NodeJS.ProcessEnv) {
  run("pnpm", ["--filter", "@rakazo/db", "generate"], env);
  run("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], env);
}

export function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  execFileSync(command, args, { cwd: repositoryRoot, env, stdio: "inherit" });
}

export function output(command: string, args: string[]) {
  return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

/** The production web build served by `vite preview`, proxying the API like a deployment. */
export function startPreview(env: NodeJS.ProcessEnv, port: number) {
  return spawn(
    "pnpm",
    [
      "--filter",
      "@rakazo/web",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: repositoryRoot, env, stdio: "inherit" },
  );
}

export async function waitForUrl(url: string) {
  const started = Date.now();
  let detail = "no response";
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await abortableDelay(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${detail}`);
}

export async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timeout = new AbortController();
  await Promise.race([exited, abortableDelay(5_000, timeout.signal)]);
  timeout.abort();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

export async function cdpMetrics(session: CDPSession) {
  const response = (await session.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return Object.fromEntries(response.metrics.map((metric) => [metric.name, metric.value]));
}

export function argument(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function positiveInteger(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`Expected a positive integer: ${value}`);
  return parsed;
}

export function safeName(value: string) {
  const name = value.toLowerCase().replace(/[^\p{L}\p{M}\p{N}._-]+/gu, "-");
  // Leave room for the longest report wrapper: web-chat-<name>.json.
  const maxBytes = 255 - Buffer.byteLength("web-chat-.json");
  if (Buffer.byteLength(name) <= maxBytes && name === name.normalize("NFC")) return name;

  // The separator is excluded from sanitized labels, reserving generated names.
  const suffix = `~${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
  const prefixBudget = maxBytes - Buffer.byteLength(suffix);
  let prefix = "";
  let bytes = 0;
  for (const character of name) {
    const size = Buffer.byteLength(character);
    if (bytes + size > prefixBudget) break;
    prefix += character;
    bytes += size;
  }
  return prefix + suffix;
}
