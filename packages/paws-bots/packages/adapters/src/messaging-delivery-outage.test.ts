import type { MessagingSurface } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { DatabaseOutage } from "@rakazo/db";
import type { LogEvent } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingDelivery } from "./messaging-delivery.js";
import { jobQueueLogger } from "./wakeup.js";

const readOnly = () =>
  Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), {
    code: "25006",
    severity: "ERROR",
  });

describe("chat delivery while the database is unavailable", () => {
  let events: LogEvent[];
  let previous: ReturnType<typeof getLogger>;
  const logged = () => events.map((event) => `${event.level}:${event.message}`);

  beforeEach(() => {
    const sink = createTestSink();
    events = sink.events;
    previous = getLogger();
    installLogger(createLogger({ service: "test", level: "debug", sinks: [sink] }));
  });

  afterEach(() => {
    installLogger(previous);
    vi.restoreAllMocks();
  });

  const messaging = { sendToThread: vi.fn(), platforms: () => [] } as unknown as MessagingSurface;

  function delivery(prisma: unknown, outage: DatabaseOutage) {
    return new MessagingDelivery({
      prisma: prisma as PrismaClient,
      messaging,
      events: { sendUserMessage: vi.fn(), notify: vi.fn() },
      jobs: { enqueue: vi.fn(), enqueueIn: vi.fn(), cancel: vi.fn(), cancelIn: vi.fn() },
      artifacts: { get: vi.fn() },
      outage,
    });
  }

  it("logs one outage for many direct sends that cannot reach the database, then its recovery", async () => {
    let down = true;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      messagingOutbound: { findFirst: vi.fn(async () => null) },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        if (down) throw new Error("timeout exceeded when trying to connect");
        return fn(tx);
      }),
    };
    const outage = new DatabaseOutage();
    const sender = delivery(prisma, outage);
    for (let send = 0; send < 25; send += 1)
      await sender.send([{ identityId: `identity-${send % 5}` }]);
    down = false;
    await sender.send([{ identityId: "identity-0" }]);
    await sender.send([{ identityId: "identity-1" }]);
    expect(logged()).toEqual([
      "error:database unavailable; backing off",
      "info:database available again",
    ]);
  });

  it("never gives a message up as failed because the database was down on its last attempt", async () => {
    const row = {
      id: "out-1",
      idempotencyKey: "msg:m1",
      kind: "dm",
      identityId: "identity-1",
      threadId: null,
      body: "hello",
      status: "retry",
      sourceMessageId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      messagingOutbound: {
        // No claim of the previous release in the conversation; this row is its head.
        findFirst: vi.fn(async ({ where }: { where: { status?: unknown } }) =>
          where.status === "sent" ? null : row,
        ),
        update: vi.fn(async () => row),
        updateMany,
      },
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
      messagingOutbound: { findUnique: vi.fn(async () => row), updateMany },
      messagingIdentity: { findUnique: vi.fn(async () => Promise.reject(readOnly())) },
    };
    const outage = new DatabaseOutage();
    await expect(
      delivery(prisma, outage).sendJob(row.id, { number: 5, max: 5 }),
    ).rejects.toMatchObject({ code: "25006" });
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "failed" } }),
    );
    expect(messaging.sendToThread).not.toHaveBeenCalled();
  });

  it("folds the job queue's own polling errors into the outage and passes everything else on", () => {
    const outage = new DatabaseOutage();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logger = jobQueueLogger(outage);
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
      code: "ECONNREFUSED",
    });
    for (let poll = 0; poll < 120; poll += 1)
      logger.error("Error occurred fetching jobs; will try again on next poll interval.", {
        error: refused,
      });
    // A task's own socket error came from the work, not the queue's connection.
    logger.error("Failed task 7 (messaging.send) with error 'connect ECONNREFUSED'", {
      failure: true,
      error: refused,
    });
    expect({
      outage: logged(),
      passedOn: consoleError.mock.calls.length,
    }).toEqual({ outage: ["error:database unavailable; backing off"], passedOn: 1 });
  });
});
