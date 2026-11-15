import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { RPCHandler } from "@orpc/server/fetch";
import type { AdapterContext, ComputerRef, JobPublisher, PortableFile } from "@rakazo/adapter-kit";
import { SandboxDamagedError, SandboxRateLimitError } from "@rakazo/adapter-kit";
import {
  createIdleComputerSweeper,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  provisionComputer,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  reconcileComputerRuns,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

class FailingSandbox extends FakeSandboxProvider {
  saveError: Error | undefined;
  stopError: Error | undefined;
  exported = vi.fn();
  stopped = vi.fn();

  override async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    this.exported();
    if (this.saveError) throw this.saveError;
    yield* super.exportWorkspace(computer, context);
  }

  override async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ): Promise<void> {
    this.stopped(options);
    if (this.stopError) throw this.stopError;
    await super.stop(computer, context);
  }
}

describePostgres("computer stop (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let dataDir: string;
  const organizations: string[] = [];

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    dataDir = await mkdtemp(join(process.cwd(), ".computer-stop-test-"));
  });

  afterAll(async () => {
    if (prisma) {
      await system.computerRun.deleteMany({ where: { spaceId: { in: organizations } } });
      await system.organization.deleteMany({ where: { id: { in: organizations } } });
      await system.user.deleteMany({ where: { id: { in: organizations } } });
      await prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  async function runningComputer() {
    const id = randomUUID();
    organizations.push(id);
    await system.user.create({
      data: { id, name: "Stop fixture", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id, name: "Stop fixture", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Fixture" } });
    const computer = await system.computer.create({
      data: { spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake" },
    });
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Fixture", color: "test", computerId: computer.id },
    });
    await system.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const sandbox = new FailingSandbox();
    const enqueue = vi.fn<JobPublisher["enqueue"]>(async () => undefined);
    const jobs: JobPublisher = {
      enqueue,
      enqueueIn: vi.fn(),
      cancelIn: vi.fn(),
      cancel: vi.fn(),
      close: async () => undefined,
    };
    const events = createThreadEvents(prisma);
    const home = new LocalAgentHomeStore(dataDir);
    const actor: Actor = {
      spaceId: id,
      userId: id,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const boot = () =>
      runAsTenant(actor, () =>
        provisionComputer({ prisma, sandbox, home, jobs, events, dataDir }, computer.id, {
          ...actor,
          botId: bot.id,
          operationId: "fixture",
          traceId: "fixture",
          signal: new AbortController().signal,
        }),
      );
    await boot();
    // Runs once, right after Stop reads the bot and its computer.
    let afterRead: (() => Promise<unknown>) | undefined;
    const reading = new Proxy(prisma, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== "bot") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(value, {
          get(bots, method) {
            const found = Reflect.get(bots, method);
            if (method !== "findFirst")
              return typeof found === "function" ? found.bind(bots) : found;
            return async (...args: unknown[]) => {
              const bot = await found.apply(bots, args);
              const hook = afterRead;
              afterRead = undefined;
              await hook?.();
              return bot;
            };
          },
        });
      },
    });
    const router = createRouter({
      prisma: reading,
      events,
      jobs,
      sandbox,
      home,
      dataDir,
      env: {},
    } as unknown as RouterDeps);
    const stop = async () => {
      const { response } = await new RPCHandler(router).handle(
        new Request("https://api.example.test/rpc/computer/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: { botId: bot.id } }),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      return response?.status;
    };
    const staleRead = (change: () => Promise<unknown>) => {
      afterRead = change;
    };
    return { computer, sandbox, enqueue, jobs, stop, boot, staleRead };
  }

  it.each([
    { when: "its save fails", saveError: new Error("export failed"), stops: false },
    {
      when: "the provider puts its stop off",
      stopError: new SandboxRateLimitError({ retryAfterMs: DAY_MS }),
      stops: true,
    },
  ])("keeps a computer running, slept when idle and metered when $when", async (failure) => {
    const { computer, sandbox, enqueue, jobs, stop } = await runningComputer();
    sandbox.saveError = failure.saveError;
    sandbox.stopError = failure.stopError;
    enqueue.mockClear();
    const startedAt = Date.now();

    expect(await stop()).toBe(500);

    expect(sandbox.stopped).toHaveBeenCalledTimes(failure.stops ? 1 : 0);
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      state: "running",
      providerRef: expect.any(String),
    });
    // Not before the provider said it takes requests again.
    const check = enqueue.mock.calls[0]?.[0];
    expect(check).toMatchObject({ name: "computer.sleep", payload: { computerId: computer.id } });
    expect((check?.availableAt?.getTime() ?? 0) >= startedAt + DAY_MS).toBe(failure.stops);
    await runAsSystem("test reconcile", () => reconcileComputerRuns(system));
    expect(
      await system.computerRun.count({ where: { computerId: computer.id, endedAt: null } }),
    ).toBe(1);
    enqueue.mockClear();
    await runAsSystem("test sweep", () => createIdleComputerSweeper({ prisma: system, jobs })());
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "computer.sleep", payload: { computerId: computer.id } }),
    );
  });

  it.each([
    { from: "stopped", stopError: undefined, status: 200, state: "stopped" },
    { from: "suspended", stopError: new SandboxRateLimitError(), status: 500, state: "suspended" },
    {
      from: "suspended",
      stopError: new Error("Boat refused the stop"),
      status: 500,
      state: "error",
    },
  ])("stops a $from computer without waking it to save it (ends $state)", async (outcome) => {
    const { computer, sandbox, stop } = await runningComputer();
    await system.computer.update({ where: { id: computer.id }, data: { state: outcome.from } });
    sandbox.stopError = outcome.stopError;

    expect(await stop()).toBe(outcome.status);

    expect(sandbox.exported).not.toHaveBeenCalled();
    expect(sandbox.stopped).toHaveBeenCalledOnce();
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      state: outcome.state,
    });
  });

  it.each([
    { when: "damaged", saveError: new SandboxDamagedError(), restorePending: false, exports: 1 },
    { when: "half restored", saveError: undefined, restorePending: true, exports: 0 },
  ])("stops an errored $when computer that is still up", async (row) => {
    const { computer, sandbox, stop } = await runningComputer();
    await system.computer.update({
      where: { id: computer.id },
      data: { state: "error", restorePending: row.restorePending },
    });
    sandbox.saveError = row.saveError;

    expect(await stop()).toBe(200);

    expect(sandbox.exported).toHaveBeenCalledTimes(row.exports);
    expect(sandbox.stopped).toHaveBeenCalledExactlyOnceWith(
      row.saveError ? { discardUnsaved: true } : undefined,
    );
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      state: "stopped",
    });
  });

  it("refuses a Stop whose computer started after it was read", async () => {
    const { computer, sandbox, stop, boot, staleRead } = await runningComputer();
    await system.computer.update({ where: { id: computer.id }, data: { state: "suspended" } });
    staleRead(boot);

    expect(await stop()).toBe(409);

    expect(sandbox.stopped).not.toHaveBeenCalled();
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      state: "running",
    });
  });

  it("still marks a computer errored when the provider fails its stop", async () => {
    const { computer, sandbox, stop } = await runningComputer();
    sandbox.stopError = new Error("Boat refused the stop");

    expect(await stop()).toBe(500);

    expect(sandbox.stopped).toHaveBeenCalledOnce();
    expect(await system.computer.findUniqueOrThrow({ where: { id: computer.id } })).toMatchObject({
      state: "error",
    });
  });
});
