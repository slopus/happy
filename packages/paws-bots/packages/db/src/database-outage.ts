import { getLogger } from "@rakazo/logging";
import { isDatabaseUnavailable } from "./client.js";

/** Bounded backoff for reconnecting to a database that is out of connections or unavailable. */
export function databaseCapacityBackoffMs(attempt: number): number {
  return Math.min(30_000, 200 * 2 ** Math.min(attempt, 8));
}

/** How often a long or flapping outage may log again. */
const OUTAGE_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * One process's view of database outages. Work that finds the database unavailable reports it
 * here instead of logging it: the first failure of an outage logs one error with its cause, a
 * long outage logs a warning with its failure count at most every few minutes, and the first
 * success after it logs one info line. A database dropping in and out within that interval logs
 * nothing more. Recurring work asks `ready` before each pass, so it backs off while it lasts.
 */
export class DatabaseOutage {
  private startedAt: number | undefined;
  private lastFailureAt = 0;
  private failures = 0;
  private logged = false;
  private lastLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Records a failure of work in `source`. Returns false, and records nothing, when the error is
   * not the database being unavailable: the caller handles it as before.
   */
  failed(
    error: unknown,
    source: string,
    options: { fromDatabaseConnection?: boolean } = {},
  ): boolean {
    if (!isDatabaseUnavailable(error, options)) return false;
    const now = this.now();
    this.failures += 1;
    this.lastFailureAt = now;
    if (this.startedAt === undefined) this.startedAt = now;
    if (now - this.lastLoggedAt < OUTAGE_LOG_INTERVAL_MS) return true;
    this.lastLoggedAt = now;
    if (this.logged)
      getLogger().warn("database still unavailable", {
        "outage.failures": this.failures,
        "outage.ms": now - this.startedAt,
      });
    else getLogger().error("database unavailable; backing off", error, { "outage.source": source });
    this.logged = true;
    return true;
  }

  /** Records database work that went through, which ends an outage. */
  succeeded(): void {
    if (this.startedAt === undefined) return;
    if (this.logged)
      getLogger().info("database available again", {
        "outage.failures": this.failures,
        "outage.ms": this.now() - this.startedAt,
      });
    this.startedAt = undefined;
    this.failures = 0;
    this.logged = false;
  }

  /**
   * Whether a recurring pass may run. During an outage each wait after a failure is as long as
   * the outage has lasted, between `minMs` and `maxMs`, so attempts thin out exponentially.
   */
  ready(minMs: number, maxMs: number): boolean {
    if (this.startedAt === undefined) return true;
    const wait = Math.min(maxMs, Math.max(minMs, this.lastFailureAt - this.startedAt));
    return this.now() >= this.lastFailureAt + wait;
  }
}

/** Shared by everything in this process, so one outage is one streak in its logs. */
export const databaseOutage = new DatabaseOutage();

/** How long work that has to land, such as ending a run, waits out a database failover. */
export const DATABASE_FAILOVER_WAIT_MS = 90_000;

/**
 * Runs `operation`, and while it fails because the database is unavailable runs it again with
 * backoff, for up to `waitMs`. Only for work that is safe to repeat, such as a write fenced by a
 * run's lease. The outage logs once for all callers; any other error is thrown at once.
 */
export async function retryWhileDatabaseUnavailable<T>(
  operation: () => Promise<T>,
  options: {
    source: string;
    signal?: AbortSignal;
    waitMs?: number;
    outage?: DatabaseOutage;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const outage = options.outage ?? databaseOutage;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (options.waitMs ?? DATABASE_FAILOVER_WAIT_MS);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await operation();
      outage.succeeded();
      return result;
    } catch (error) {
      if (
        options.signal?.aborted ||
        Date.now() >= deadline ||
        !outage.failed(error, options.source, { fromDatabaseConnection: true })
      )
        throw error;
      await sleep(Math.min(5_000, databaseCapacityBackoffMs(attempt)));
      if (options.signal?.aborted) throw error;
    }
  }
}
