import type { JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DatabaseOutage } from "@rakazo/db";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobReconciler } from "./job-reconciler.js";

const READ_ONLY = () =>
  Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
    code: "25006",
    severity: "ERROR",
  });

/** Every model call answers with nothing while the database is up, and fails while it is down. */
function fakeDatabase(state: { down: () => Error | null }) {
  const answer = (method: string) =>
    method.startsWith("findMany") || method === "$queryRaw" || method === "updateManyAndReturn"
      ? []
      : method.startsWith("update") || method.startsWith("delete")
        ? { count: 0 }
        : method === "count"
          ? 0
          : null;
  const call = (method: string) => async () => {
    const error = state.down();
    if (error) throw error;
    return answer(method);
  };
  const prisma: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, model: string) {
        if (model === "then") return undefined;
        if (model === "$transaction")
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            const error = state.down();
            if (error) throw error;
            return fn(prisma);
          };
        if (model.startsWith("$")) return call(model);
        return new Proxy({}, { get: (_model, method: string) => call(method) });
      },
    },
  );
  return prisma as unknown as PrismaClient;
}

describe("job reconciliation while the database is unavailable", () => {
  let events: LogEvent[];
  let previous: ReturnType<typeof getLogger>;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-13T00:00:00Z") });
    const sink = createTestSink();
    events = sink.events;
    previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
  });

  afterEach(() => {
    installLogger(previous);
    vi.useRealTimers();
  });

  it.each([
    ["read-only", READ_ONLY],
    ["pool checkout timeouts", () => new Error("timeout exceeded when trying to connect")],
  ])(
    "backs off and logs one outage while %s lasts, then recovers and runs every interval",
    async (_name, failure) => {
      const started = Date.now();
      let downUntil = started + 10 * 60_000;
      const state = { down: () => (Date.now() < downUntil ? failure() : null) };
      const passes: number[] = [];
      const reconciler = createJobReconciler(
        {
          prisma: fakeDatabase(state),
          jobs: { enqueue: vi.fn(async () => undefined) } as unknown as JobPublisher,
          leadership: {
            tryAcquire: async () => {
              passes.push((Date.now() - started) / 1_000);
              return true;
            },
            release: async () => undefined,
          },
          // A sweep that fails on the same outage still makes it one streak.
          reconcileChatDelivery: async () => {
            const error = state.down();
            if (error) throw error;
          },
          outage: new DatabaseOutage(),
        },
        { intervalMs: 30_000 },
      );
      reconciler.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      const duringOutage = [...passes];
      // Back now: the next pass that is due runs, and the cadence returns to the interval.
      downUntil = 0;
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await reconciler.stop();

      expect(duringOutage).toEqual([0, 30, 60, 120, 240, 360, 480]);
      const after = passes.slice(duringOutage.length);
      expect(after.slice(0, 2)).toEqual([600, 630]);
      expect(after.every((at, index) => index === 0 || at - after[index - 1]! === 30)).toBe(true);
      // One error as it starts, one summary five minutes in, one line when it is back.
      expect(events.map((event) => `${event.level}:${event.message}`)).toEqual([
        "error:database unavailable; backing off",
        "warn:database still unavailable",
        "info:database available again",
      ]);
    },
  );
});
