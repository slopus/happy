import { PrismaPg } from "@prisma/adapter-pg";
import type { KeyProvider } from "@rakazo/adapter-kit";
import { resolveContentEncryption } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { withContentEncryption } from "./content-encryption.js";
import {
  ContentKeyRing,
  LocalKeyProvider,
  lazyKeyProvider,
  masterKeysFromEnv,
  PgSpaceKeyStore,
} from "./content-keys.js";
import { PrismaClient } from "./generated/prisma/client.js";
import {
  installDbContext,
  rlsBypassKey,
  WRAPPED_OPERATION_OPTIONS,
  withRowLevelSecurity,
} from "./row-security.js";
import { withTextSanitization } from "./text-sanitization.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
  /** Wraps per-space content keys. Defaults to master keys from the environment. */
  keyProvider?: KeyProvider;
  /** Encrypt new content. Defaults to CONTENT_ENCRYPTION (see resolveContentEncryption). */
  encryptContent?: boolean;
}

const DEFAULT_POOL_MAX = 4;
const CHECKOUT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_ATTEMPTS = 8;
const SLOW_CHECKOUT_MS = 1_000;
const SATURATION_REPORT_INTERVAL_MS = 10_000;

/**
 * Probe a quiet connection after 10s instead of the OS default of hours, so one a failover cut
 * without closing it is found dead within seconds instead of hanging the work that holds it.
 */
export const DATABASE_KEEPALIVE = { keepAlive: true, keepAliveInitialDelayMillis: 10_000 };

/**
 * A query that never answers is on a connection that died mid-query. Longer than the longest
 * transaction any work may hold, so it only ends queries no server is running anymore.
 */
const QUERY_TIMEOUT_MS = WRAPPED_OPERATION_OPTIONS.timeout + 30_000;

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Fail a checkout instead of queueing forever when Postgres is already at
    // max_connections (53300) or the pool is saturated.
    connectionTimeoutMillis: CHECKOUT_TIMEOUT_MS,
    // 0 disables idle eviction. Dropping idle clients and reopening them on the
    // next job burst is how a tight Postgres hits 53300; keep what we already have.
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    query_timeout: QUERY_TIMEOUT_MS,
    ...DATABASE_KEEPALIVE,
  });
  // graphile-worker (and Node itself) require an 'error' listener on a shared
  // pool: an idle-client disconnect is otherwise an unhandled error that kills
  // the process and orphans the TCP sessions until Postgres times them out.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  installConnectRetry(pool);
  installDbContext(pool);
  installSaturationReport(pool, options.applicationName);
  return pool;
}

/**
 * The returned client encrypts user content at rest (see content-encryption.ts);
 * with encryption off it writes plaintext and still decrypts existing ciphertext.
 * Space keys use a separate two-connection pool that `pool.end()` also closes.
 */
export function createDb(
  connectionString: string,
  options: DbClientOptions = {},
): { prisma: PrismaClient; pool: Pool; contentKeys: ContentKeyRing } {
  // Read first, so an invalid CONTENT_ENCRYPTION stops startup before any pool opens.
  const encryptWrites = options.encryptContent ?? resolveContentEncryption();
  // Without the configured key manager, new space keys would quietly be wrapped by
  // master keys held on this host.
  if (!options.keyProvider && (process.env.MASTER_KEY_PROVIDER?.trim() || "local") !== "local")
    throw new Error(
      "MASTER_KEY_PROVIDER needs createDb(url, { keyProvider }) from @rakazo/adapters",
    );
  const pool = createPool(connectionString, options);
  const keyPool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: CHECKOUT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName && `${options.applicationName}-keys`,
    query_timeout: QUERY_TIMEOUT_MS,
    ...DATABASE_KEEPALIVE,
  });
  keyPool.on("error", () => undefined);
  installDbContext(keyPool);
  installSaturationReport(keyPool, keyPool.options.application_name);
  const end = pool.end.bind(pool) as () => Promise<void>;
  pool.end = (async () => {
    await keyPool.end().catch(() => undefined);
    await end();
  }) as Pool["end"];
  const contentKeys = new ContentKeyRing(
    options.keyProvider ?? lazyKeyProvider(() => new LocalKeyProvider(masterKeysFromEnv())),
    new PgSpaceKeyStore(keyPool),
    { encryptWrites },
  );
  const adapter = new PrismaPg(pool);
  // A transaction waits for a connection as long as any other query does. Prisma's 2s
  // default failed runs whenever a busy pool took a few seconds to free a connection.
  const client = new PrismaClient({
    adapter,
    transactionOptions: { maxWait: CHECKOUT_TIMEOUT_MS },
  });
  // Row-level security wraps everything else, so its findUnique rewrite still runs
  // through content encryption. Text is cleaned for Postgres before any of them see it.
  const prisma = withTextSanitization(
    withRowLevelSecurity(
      withContentEncryption(client, contentKeys),
      rlsBypassKey(connectionString),
    ),
  );
  return { prisma, pool, contentKeys };
}

export function isTooManyDatabaseConnections(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (code === "P2037" || code === "53300") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Too many database connections opened") ||
      message.includes("sorry, too many clients already")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** pg-pool's error when no connection frees up within `connectionTimeoutMillis`. */
export function isPoolCheckoutTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === "timeout exceeded when trying to connect";
}

/**
 * Postgres codes, Prisma codes and pg driver adapter error kinds that say the database cannot
 * take the work right now: read-only during a failover, shutting down or starting up, out of
 * connections, or not reachable.
 */
const UNAVAILABLE_CODES = new Set([
  "25006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "P1001",
  "P1002",
  "P1017",
  "P2024",
  "P2037",
]);
const UNAVAILABLE_KINDS = new Set([
  "DatabaseNotReachable",
  "ConnectionClosed",
  "SocketTimeout",
  "TooManyConnections",
]);
/** Raw socket failures, which only count when the caller knows they came from a database connection. */
const SOCKET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);
/** pg's own errors for a connection that died: `query_timeout` firing, or the socket closing. */
const UNAVAILABLE_MESSAGE =
  /read-only transaction|^Connection terminated|Can't reach database server|^Query read timeout$/;

/**
 * Whether an error means the database is unavailable rather than that the work is wrong, so
 * callers back off and wait instead of failing the work. Follows causes, Prisma's driver adapter
 * error and aggregated connection attempts. Socket errors also come from other services, so they
 * count only with `fromDatabaseConnection`.
 */
export function isDatabaseUnavailable(
  error: unknown,
  options: { fromDatabaseConnection?: boolean } = {},
): boolean {
  if (isTooManyDatabaseConnections(error)) return true;
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (isPoolCheckoutTimeout(current)) return true;
    const fields = current as Record<string, unknown>;
    for (const key of ["code", "originalCode"]) {
      const code = fields[key];
      if (typeof code !== "string") continue;
      if (UNAVAILABLE_CODES.has(code)) return true;
      if (options.fromDatabaseConnection && SOCKET_CODES.has(code)) return true;
    }
    if (typeof fields.kind === "string" && UNAVAILABLE_KINDS.has(fields.kind)) return true;
    if (current instanceof Error && UNAVAILABLE_MESSAGE.test(current.message)) return true;
    pending.push(fields.cause, fields.meta, fields.driverAdapterError);
    if (Array.isArray(fields.errors)) pending.push(...fields.errors);
  }
  return false;
}

export async function retryOnTooManyConnections<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONNECT_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTooManyDatabaseConnections(error) || attempt >= attempts - 1) throw error;
      await sleep(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
}

function installConnectRetry(pool: Pool): void {
  type ConnectCallback = (
    err: Error,
    client: PoolClient,
    done: (release?: boolean) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    if (!callback) return retryOnTooManyConnections(() => originalConnect());
    const attempt = (n: number) => {
      originalConnect((err, client, done) => {
        if (err && isTooManyDatabaseConnections(err) && n < CONNECT_RETRY_ATTEMPTS - 1) {
          setTimeout(() => attempt(n + 1), Math.min(5_000, 200 * 2 ** n));
          return;
        }
        callback(err, client, done);
      });
    };
    attempt(0);
  }

  pool.connect = connect as Pool["connect"];
}

/**
 * Warn when a checkout waited for a free connection, at most once per interval, so a pool
 * that is running out shows up in the logs before requests start timing out on it.
 */
export function installSaturationReport(
  pool: Pool,
  name: string | undefined,
  now: () => number = Date.now,
): void {
  type ConnectCallback = (
    err: Error | undefined,
    client: PoolClient | undefined,
    done: (release?: unknown) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };
  let reportedAt = -Infinity;
  const report = (startedAt: number) => {
    const at = now();
    const waitMs = at - startedAt;
    if (waitMs < SLOW_CHECKOUT_MS || at - reportedAt < SATURATION_REPORT_INTERVAL_MS) return;
    reportedAt = at;
    getLogger().warn("db.pool.saturated", {
      "db.pool.name": name,
      "db.pool.max": pool.options.max,
      "db.pool.total": pool.totalCount,
      "db.pool.idle": pool.idleCount,
      "db.pool.waiting": pool.waitingCount,
      "db.pool.wait_ms": waitMs,
    });
  };

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const startedAt = now();
    if (!callback) return originalConnect().finally(() => report(startedAt));
    originalConnect((err, client, done) => {
      report(startedAt);
      callback(err, client, done);
    });
  }

  pool.connect = connect as Pool["connect"];
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
