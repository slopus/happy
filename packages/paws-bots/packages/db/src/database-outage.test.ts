import type { LogEvent } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDatabaseUnavailable } from "./client.js";
import { DatabaseOutage, retryWhileDatabaseUnavailable } from "./database-outage.js";

/** Prisma's error for a write during a failover, as its pg driver adapter reports it. */
function readOnlyPrismaError() {
  return Object.assign(new Error("Database error. Code: `25006`."), {
    code: "P2039",
    meta: {
      driverAdapterError: Object.assign(
        new Error("cannot execute INSERT in a read-only transaction"),
        {
          cause: { kind: "postgres", code: "25006", originalCode: "25006" },
        },
      ),
    },
  });
}

describe("isDatabaseUnavailable", () => {
  it.each([
    ["a write on a read-only database through Prisma", readOnlyPrismaError()],
    [
      "an unreachable database through Prisma",
      Object.assign(new Error("Can't reach database server at db:5432"), {
        code: "P1001",
        meta: { driverAdapterError: { cause: { kind: "DatabaseNotReachable" } } },
      }),
    ],
    [
      "a read-only error from pg",
      Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
        code: "25006",
        severity: "ERROR",
      }),
    ],
    ["a pool checkout timeout", new Error("timeout exceeded when trying to connect")],
    ["too many clients", new Error("sorry, too many clients already")],
    ["a query on a connection that died", new Error("Query read timeout")],
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    [
      "an administrator shutdown",
      Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      }),
    ],
    ["a wrapped cause", new Error("job failed", { cause: readOnlyPrismaError() })],
  ])("counts %s", (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it("counts a refused socket only when it came from a database connection", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    expect({
      unknownSource: isDatabaseUnavailable(refused),
      database: isDatabaseUnavailable(refused, { fromDatabaseConnection: true }),
      vendor: isDatabaseUnavailable(
        new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      ),
    }).toEqual({ unknownSource: false, database: true, vendor: false });
  });

  it("does not count errors in the work itself", () => {
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error("Slack rejected the message"))).toBe(false);
  });
});

describe("DatabaseOutage", () => {
  let events: LogEvent[];
  let previous: ReturnType<typeof getLogger>;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    const sink = createTestSink();
    events = sink.events;
    previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    installLogger(previous);
  });

  const logged = () => events.map((event) => `${event.level}:${event.message}`);

  it("logs an outage once when it starts and once when it ends, however often work fails", () => {
    const outage = new DatabaseOutage(now);
    for (let tick = 0; tick < 60; tick += 1) {
      expect(outage.failed(readOnlyPrismaError(), "test")).toBe(true);
      clock += 1_000;
    }
    outage.succeeded();
    outage.succeeded();
    expect(logged()).toEqual([
      "error:database unavailable; backing off",
      "info:database available again",
    ]);
    expect(events[0]?.error?.message).toContain("25006");
    expect(events[1]).toMatchObject({ "outage.failures": 60, "outage.ms": 60_000 });
  });

  it("summarizes a long outage with its failure count every few minutes", () => {
    const outage = new DatabaseOutage(now);
    for (let tick = 0; tick < 12 * 60; tick += 1) {
      outage.failed(new Error("timeout exceeded when trying to connect"), "test");
      clock += 1_000;
    }
    expect(logged()).toEqual([
      "error:database unavailable; backing off",
      "warn:database still unavailable",
      "warn:database still unavailable",
    ]);
    expect(events[1]).toMatchObject({ "outage.failures": 301 });
  });

  it("stays quiet while the database drops in and out", () => {
    const outage = new DatabaseOutage(now);
    for (let flap = 0; flap < 20; flap += 1) {
      outage.failed(readOnlyPrismaError(), "test");
      clock += 5_000;
      outage.succeeded();
      clock += 5_000;
    }
    expect(logged()).toEqual([
      "error:database unavailable; backing off",
      "info:database available again",
    ]);
  });

  it("leaves every other error to its caller", () => {
    const outage = new DatabaseOutage(now);
    expect(outage.failed(new Error("bad input"), "test")).toBe(false);
    outage.succeeded();
    expect({ logs: logged(), ready: outage.ready(30_000, 120_000) }).toEqual({
      logs: [],
      ready: true,
    });
  });

  it("thins out recurring passes exponentially up to a cap, and resumes once the database is back", () => {
    const outage = new DatabaseOutage(now);
    const started = clock;
    const attempts: number[] = [];
    // A pass every 30s that fails while the outage lasts 20 minutes.
    for (let tick = 0; tick <= 40; tick += 1) {
      clock = started + tick * 30_000;
      if (!outage.ready(30_000, 120_000)) continue;
      attempts.push((clock - started) / 1_000);
      if (tick < 40) outage.failed(readOnlyPrismaError(), "test");
      else outage.succeeded();
    }
    expect(attempts).toEqual([0, 30, 60, 120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200]);
    expect(outage.ready(30_000, 120_000)).toBe(true);
  });
});

describe("retryWhileDatabaseUnavailable", () => {
  let events: LogEvent[];
  let previous: ReturnType<typeof getLogger>;
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };

  beforeEach(() => {
    const sink = createTestSink();
    events = sink.events;
    previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
    waits.length = 0;
  });

  afterEach(() => {
    installLogger(previous);
  });

  /** Work that finds the database unavailable `failures` times, then goes through. */
  function failingTimes(failures: number) {
    let calls = 0;
    const work = async () => {
      calls += 1;
      if (calls <= failures) throw readOnlyPrismaError();
      return "done";
    };
    return { work, calls: () => calls };
  }

  it("runs work again with backoff until the database is back, logging the outage once", async () => {
    const outage = new DatabaseOutage();
    const { work, calls } = failingTimes(4);
    await expect(
      retryWhileDatabaseUnavailable(work, { source: "test", outage, sleep }),
    ).resolves.toBe("done");
    expect(calls()).toBe(5);
    expect(waits).toEqual([200, 400, 800, 1_600]);
    expect(events.map((event) => `${event.level}:${event.message}`)).toEqual([
      "error:database unavailable; backing off",
      "info:database available again",
    ]);
  });

  it("throws any other error at once", async () => {
    const work = async () => {
      throw new Error("bad input");
    };
    await expect(
      retryWhileDatabaseUnavailable(work, { source: "test", outage: new DatabaseOutage(), sleep }),
    ).rejects.toThrow("bad input");
    expect({ waits, events }).toEqual({ waits: [], events: [] });
  });

  it("gives up once the wait is spent or the process is stopping", async () => {
    const outage = new DatabaseOutage();
    await expect(
      retryWhileDatabaseUnavailable(failingTimes(1).work, {
        source: "test",
        outage,
        sleep,
        waitMs: 0,
      }),
    ).rejects.toThrow("25006");
    const stopping = AbortSignal.abort();
    await expect(
      retryWhileDatabaseUnavailable(failingTimes(1).work, {
        source: "test",
        outage,
        sleep,
        signal: stopping,
      }),
    ).rejects.toThrow("25006");
    expect(waits).toEqual([]);
    const stop = new AbortController();
    const work = vi.fn(async () => {
      throw readOnlyPrismaError();
    });
    await expect(
      retryWhileDatabaseUnavailable(work, {
        source: "test",
        outage,
        signal: stop.signal,
        sleep: async () => stop.abort(),
      }),
    ).rejects.toThrow("25006");
    expect(work).toHaveBeenCalledTimes(1);
  });
});
