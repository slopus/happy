import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  installSaturationReport,
  isPoolCheckoutTimeout,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  retryOnTooManyConnections,
} from "./client.js";

const pools: Array<{ end: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe("createDb", () => {
  it("caps the pg pool and swallows idle-client errors so they cannot crash the process", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo", {
      poolMax: 3,
      applicationName: "rakazo-test",
    });
    pools.push(pool);

    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.idleTimeoutMillis).toBe(0);
    expect(pool.options.application_name).toBe("rakazo-test");
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(pool.listenerCount("connect")).toBeGreaterThan(0);

    expect(() => pool.emit("error", new Error("idle client lost"))).not.toThrow();
  });

  it("defaults to a four-connection pool", () => {
    const { pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    expect(pool.options.max).toBe(4);
  });

  it("lets a transaction wait for a busy pool past Prisma's 2s default", async () => {
    const { prisma, pool } = createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo");
    pools.push(pool);
    const released = new Error("connection freed after 2.5s");
    pool.connect = (() =>
      new Promise((_, reject) => setTimeout(() => reject(released), 2_500))) as Pool["connect"];

    await expect(prisma.$transaction(async () => "done")).rejects.toThrow(released.message);
  });

  it("refuses local master keys when a key manager is configured", () => {
    vi.stubEnv("MASTER_KEY_PROVIDER", "aws-kms");
    try {
      expect(() => createDb("postgres://rakazo:rakazo@127.0.0.1:9/rakazo")).toThrow(
        "MASTER_KEY_PROVIDER needs createDb(url, { keyProvider })",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("parsePositiveInteger", () => {
  it("falls back when the value is missing, zero, or not an integer", () => {
    expect(parsePositiveInteger(undefined, 8)).toBe(8);
    expect(parsePositiveInteger("0", 8)).toBe(8);
    expect(parsePositiveInteger("nope", 8)).toBe(8);
    expect(parsePositiveInteger("6", 8)).toBe(6);
  });
});

describe("isPoolCheckoutTimeout", () => {
  it("matches only pg-pool's checkout timeout", () => {
    expect(isPoolCheckoutTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(
      isPoolCheckoutTimeout(new Error("Connection terminated due to connection timeout")),
    ).toBe(false);
    expect(isPoolCheckoutTimeout(undefined)).toBe(false);
  });
});

describe("isTooManyDatabaseConnections", () => {
  it("recognises Prisma P2037 and Postgres 53300", () => {
    expect(isTooManyDatabaseConnections({ code: "P2037" })).toBe(true);
    expect(isTooManyDatabaseConnections({ code: "53300" })).toBe(true);
    expect(
      isTooManyDatabaseConnections(
        new Error("Too many database connections opened: sorry, too many clients already"),
      ),
    ).toBe(true);
    expect(isTooManyDatabaseConnections(new Error("relation does not exist"))).toBe(false);
    expect(isTooManyDatabaseConnections(undefined)).toBe(false);
  });

  it("walks a nested cause, matching the pg-pool unhandledRejection shape", () => {
    const root = Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
    expect(isTooManyDatabaseConnections(new Error("pool.connect failed", { cause: root }))).toBe(
      true,
    );
  });
});

describe("retryOnTooManyConnections", () => {
  it("retries 53300 and returns the first success", async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    const result = await retryOnTooManyConnections(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("sorry, too many clients already"), { code: "53300" });
        }
        return "ok";
      },
      { sleep },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated failures", async () => {
    const error = new Error("relation does not exist");
    await expect(
      retryOnTooManyConnections(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});

describe("installSaturationReport", () => {
  it("warns once per interval when a checkout waited for a connection", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink], level: "debug" }));
    let clock = 0;
    const waits = [1_500, 10, 2_000, 10_000];
    const pool = {
      options: { max: 4 },
      totalCount: 4,
      idleCount: 0,
      waitingCount: 3,
      connect: (callback?: (err: undefined, client: PoolClient, done: () => void) => void) => {
        clock += waits.shift() ?? 0;
        const client = {} as PoolClient;
        if (!callback) return Promise.resolve(client);
        callback(undefined, client, () => undefined);
      },
    } as unknown as Pool;
    installSaturationReport(pool, "rakazo-api", () => clock);

    await pool.connect();
    pool.connect(() => undefined);
    await pool.connect();
    await pool.connect();

    const warnings = sink.events.filter((event) => event.message === "db.pool.saturated");
    expect(warnings).toMatchObject([
      {
        "db.pool.name": "rakazo-api",
        "db.pool.max": 4,
        "db.pool.waiting": 3,
        "db.pool.wait_ms": 1_500,
      },
      { "db.pool.wait_ms": 10_000 },
    ]);
  });
});
