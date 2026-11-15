import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DatabaseOutage } from "@rakazo/db";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InMemoryRealtimeFanout } from "./realtime.js";
import { RunStarter, RunWorkerHost } from "./run-wakeup.js";

let events: LogEvent[];
let previous: ReturnType<typeof getLogger>;
beforeEach(() => {
  const sink = createTestSink();
  events = sink.events;
  previous = getLogger();
  installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
});
afterEach(() => installLogger(previous));

it("logs a database outage once while every recovery scan and queue check fails", async () => {
  let down = true;
  const scans = vi.fn(async () => {
    if (down) throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
    return [];
  });
  const prisma = {
    run: { findMany: scans },
    $queryRaw: async () => {
      if (down) throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
      return [{ delayedRuns: 0, oldestDueAt: null, oldestRunId: null }];
    },
  } as unknown as PrismaClient;
  const realtime = new InMemoryRealtimeFanout();
  const host = new RunWorkerHost(prisma, realtime, new RunStarter(realtime), {
    intervalMs: 5,
    outage: new DatabaseOutage(),
  });
  await host.start({} as BackgroundJobHandlers);
  try {
    await vi.waitFor(() => expect(scans.mock.calls.length).toBeGreaterThanOrEqual(5));
    down = false;
    await vi.waitFor(() =>
      expect(events.map((event) => event.message)).toContain("database available again"),
    );
  } finally {
    await host.stop();
  }
  expect(events.map((event) => `${event.level}:${event.message}`)).toEqual([
    "error:database unavailable; backing off",
    "info:database available again",
  ]);
});
