import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  asSystem,
  createDb,
  reconcileComputerRuns,
  recordComputerRunEnd,
  recordComputerRunStart,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleepComputerIfIdle } from "./computer-idle.js";
import { provisionComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const url = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE === "1" && url ? describe : describe.skip;

describePostgres("computer runs (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let dataDir: string;
  let owners = 0;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-runs-"));
  });

  afterAll(async () => {
    if (db) {
      await system.computerRun.deleteMany({ where: { computerId: { startsWith: stamp } } });
      await system.organization.deleteMany({ where: { id: { startsWith: stamp } } });
      await system.user.deleteMany({ where: { id: { startsWith: stamp } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** A user, their space, and a stopped Team Computer in it. */
  async function owner() {
    owners += 1;
    const id = `${stamp}-${owners}`;
    await system.user.create({
      data: { id, name: "Run Owner", email: `${id}@example.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id, name: "Runs", slug: id, createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Runs" } });
    const computer = await system.computer.create({
      data: { id, spaceId: id, userId: id, scopeKey: id, homeKey: id, kind: "fake" },
    });
    const sandbox = new FakeSandboxProvider();
    const deps = {
      prisma: db.prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs: {
        enqueue: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as JobPublisher,
      events: { append: vi.fn().mockResolvedValue({}) } as unknown as ThreadEvents,
      dataDir,
    };
    const tenant = { spaceId: id, userId: id };
    const context: AdapterContext = {
      operationId: "computer-runs-test",
      traceId: "computer-runs-test",
      ...tenant,
      signal: new AbortController().signal,
    };
    // Starts run in the signed-in user's request, so they also prove the tenant policy.
    const start = () => runAsTenant(tenant, () => provisionComputer(deps, computer.id, context));
    const sleep = () => runAsSystem("idle job", () => sleepComputerIfIdle(deps, computer.id));
    const runs = () =>
      system.computerRun.findMany({
        where: { computerId: computer.id },
        orderBy: { startedAt: "asc" },
      });
    return { id, computer, sandbox, tenant, start, sleep, runs };
  }

  it("opens a run when the computer starts and ends it when idle shutdown stops it", async () => {
    const o = await owner();

    await o.start();
    const { runningSince, providerRef, screenGeneration } = await system.computer.findUniqueOrThrow(
      { where: { id: o.id } },
    );
    expect(providerRef).toBeTruthy();
    // A reconnect within the same stretch is the same run, and keeps open screens.
    await o.start();
    expect(
      (await system.computer.findUniqueOrThrow({ where: { id: o.id } })).screenGeneration,
    ).toBe(screenGeneration);
    const open = await runAsTenant(o.tenant, () =>
      db.prisma.computerRun.findMany({ where: { computerId: o.id } }),
    );
    expect(open).toEqual([
      expect.objectContaining({
        spaceId: o.id,
        userId: o.id,
        kind: "fake",
        providerRef,
        startedAt: runningSince,
        endedAt: null,
        endReason: null,
      }),
    ]);

    await o.sleep();

    expect((await system.computer.findUniqueOrThrow({ where: { id: o.id } })).state).toBe(
      "suspended",
    );
    const [ended] = await o.runs();
    expect(ended).toMatchObject({ startedAt: runningSince, endReason: "idle" });
    expect(ended!.endedAt!.getTime()).toBeGreaterThanOrEqual(runningSince!.getTime());

    // The next start is a new run.
    await o.start();
    expect((await o.runs()).map((run) => run.endReason)).toEqual(["idle", null]);
  });

  it("sleeps past a run waiting for takeover, but not past a run using the computer", async () => {
    const o = await owner();
    await o.start();
    const bot = await system.bot.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        name: "Waiting",
        color: "ink",
        computerId: o.id,
        thread: { create: { spaceId: o.id, userId: o.id } },
      },
      include: { thread: true },
    });
    const threadId = bot.thread!.id;
    const task = await system.task.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        botId: bot.id,
        threadId,
        prompt: "Log in",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        botId: bot.id,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user_message",
      },
    });
    await system.computerExecutionLease.create({
      data: {
        computerId: o.id,
        botId: bot.id,
        runId: run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });

    await o.sleep();
    expect((await system.computer.findUniqueOrThrow({ where: { id: o.id } })).state).toBe(
      "running",
    );

    await system.run.update({ where: { id: run.id }, data: { status: "waiting_takeover" } });
    await o.sleep();
    expect((await system.computer.findUniqueOrThrow({ where: { id: o.id } })).state).toBe(
      "suspended",
    );
  });

  it("sleeps past a background helper, which never uses the computer", async () => {
    const o = await owner();
    await o.start();
    const bot = await system.bot.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        name: "Delegating",
        color: "ink",
        computerId: o.id,
        thread: { create: { spaceId: o.id, userId: o.id } },
      },
    });
    const helperThread = await system.thread.create({
      data: { spaceId: o.id, userId: o.id, helperBotId: bot.id },
    });
    const task = await system.task.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        botId: bot.id,
        threadId: helperThread.id,
        prompt: "Compare venues",
        status: "running",
      },
    });
    const helper = await system.run.create({
      data: {
        spaceId: o.id,
        userId: o.id,
        botId: bot.id,
        threadId: helperThread.id,
        taskId: task.id,
        status: "running",
        trigger: "helper",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    await o.sleep();
    expect((await system.computer.findUniqueOrThrow({ where: { id: o.id } })).state).toBe(
      "suspended",
    );
    // The same run as the bot's own turn keeps the computer up.
    await o.start();
    await system.run.update({ where: { id: helper.id }, data: { trigger: "user" } });
    await o.sleep();
    expect((await system.computer.findUniqueOrThrow({ where: { id: o.id } })).state).toBe(
      "running",
    );
  });

  it("ends the run when the provider has already lost the sandbox", async () => {
    const o = await owner();
    await o.start();
    o.sandbox.exportWorkspace = async function* () {
      yield* [];
      throw Object.assign(new Error("sandbox removed"), { name: "SandboxNotFoundError" });
    };

    await o.sleep();

    expect(await system.computer.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      state: "stopped",
      providerRef: null,
    });
    expect(await o.runs()).toEqual([
      expect.objectContaining({ endedAt: expect.any(Date), endReason: "gone" }),
    ]);
  });

  it("ends a run lost at the provider when it was last seen running, not when that was noticed", async () => {
    const lostAtStart = await owner();
    const lostBySleep = await owner();
    const lostUnseen = await owner();
    await Promise.all([lostAtStart.start(), lostBySleep.start(), lostUnseen.start()]);
    const lastSeenAt = new Date(Date.now() - 3 * 60 * 60_000);
    const startedAt = new Date(lastSeenAt.getTime() - 60 * 60_000);
    for (const o of [lostAtStart, lostBySleep]) {
      await system.computer.update({ where: { id: o.id }, data: { runningSince: startedAt } });
      await system.computerRun.updateMany({
        where: { computerId: o.id },
        data: { startedAt, lastSeenAt },
      });
    }
    await system.computer.update({
      where: { id: lostUnseen.id },
      data: { runningSince: startedAt },
    });
    await system.computerRun.updateMany({
      where: { computerId: lostUnseen.id },
      data: { startedAt, lastSeenAt: null },
    });

    // The next start has to bring the computer back, and the idle check finds it gone.
    await runAsTenant(lostAtStart.tenant, () =>
      recordComputerRunStart(db.prisma, lostAtStart.computer, new Date(), "gone"),
    );
    for (const o of [lostBySleep, lostUnseen]) {
      o.sandbox.isRunning = async () => false;
      o.sandbox.exportWorkspace = async function* () {
        yield* [];
        throw Object.assign(new Error("sandbox removed"), { name: "SandboxNotFoundError" });
      };
      await o.sleep();
    }

    const [lostAtStartRun] = await lostAtStart.runs();
    expect(lostAtStartRun).toMatchObject({ endReason: "gone", endedAt: lastSeenAt });
    expect(await lostBySleep.runs()).toEqual([
      expect.objectContaining({ endReason: "gone", endedAt: lastSeenAt }),
    ]);
    // Never seen running: the end stays when it was noticed.
    const [unseen] = await lostUnseen.runs();
    expect(unseen!.endReason).toBe("gone");
    expect(unseen!.endedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("closes the open runs of deleted and stopped computers, and leaves running ones open", async () => {
    const deleted = await owner();
    const stopped = await owner();
    const running = await owner();
    await Promise.all([deleted.start(), stopped.start(), running.start()]);
    // A crash or deploy between the provider stop or deletion and the usage write.
    await system.computer.delete({ where: { id: deleted.id } });
    await system.computer.update({ where: { id: stopped.id }, data: { state: "stopped" } });

    await runAsSystem("reconciler", () => reconcileComputerRuns(db.prisma));

    expect(await deleted.runs()).toEqual([
      expect.objectContaining({ endedAt: expect.any(Date), endReason: "deleted" }),
    ]);
    expect(await stopped.runs()).toEqual([
      expect.objectContaining({ endedAt: expect.any(Date), endReason: "reconciled" }),
    ]);
    expect(await running.runs()).toEqual([expect.objectContaining({ endedAt: null })]);
  });

  it("closes a stale run left open behind a newer stretch", async () => {
    const o = await owner();
    await o.start();
    const stale = new Date(Date.now() - 3 * 60 * 60_000);
    await system.computerRun.create({
      data: { computerId: o.id, spaceId: o.id, userId: o.id, kind: "fake", startedAt: stale },
    });

    await runAsSystem("reconciler", () => reconcileComputerRuns(db.prisma));

    expect(
      (await o.runs()).map((run) => [run.startedAt.getTime() === stale.getTime(), run.endReason]),
    ).toEqual([
      [true, "reconciled"],
      [false, null],
    ]);
  });

  it("opens the run of a running computer whose start was never recorded", async () => {
    const o = await owner();
    await o.start();
    const { runningSince, providerRef } = await system.computer.findUniqueOrThrow({
      where: { id: o.id },
    });
    // A crash between activating the computer and writing its run.
    await system.computerRun.deleteMany({ where: { computerId: o.id } });

    await runAsSystem("reconciler", () => reconcileComputerRuns(db.prisma));
    await runAsSystem("reconciler", () => reconcileComputerRuns(db.prisma));

    expect(await o.runs()).toEqual([
      expect.objectContaining({
        userId: o.id,
        kind: "fake",
        providerRef,
        startedAt: runningSince,
        endedAt: null,
        lastSeenAt: runningSince,
      }),
    ]);
  });

  it("does not let a late stop close the run of a restart that beat it", async () => {
    const o = await owner();
    await o.start();
    const before = await system.computer.findUniqueOrThrow({ where: { id: o.id } });
    // Suspend without its usage write, then restart before that write lands.
    await system.computer.update({ where: { id: o.id }, data: { state: "suspended" } });
    await o.start();

    await runAsSystem("idle job", () => recordComputerRunEnd(db.prisma, before, "idle"));

    // The restart already closed the earlier run; the new one stays open.
    expect((await o.runs()).map((run) => run.endReason)).toEqual(["reconciled", null]);
  });

  it("keeps the run time but not who it belonged to when the account and space are deleted", async () => {
    const o = await owner();
    await o.start();
    await system.computer.delete({ where: { id: o.id } });

    await system.organization.delete({ where: { id: o.id } });
    await system.user.delete({ where: { id: o.id } });

    expect(await o.runs()).toEqual([
      expect.objectContaining({ computerId: o.id, spaceId: null, userId: null, kind: "fake" }),
    ]);
  });

  it("does not record host computers, whose stop only Electron sees", async () => {
    const o = await owner();

    await runAsTenant(o.tenant, () =>
      recordComputerRunStart(db.prisma, { ...o.computer, kind: "desktop" }, new Date()),
    );

    expect(await o.runs()).toEqual([]);
  });
});
