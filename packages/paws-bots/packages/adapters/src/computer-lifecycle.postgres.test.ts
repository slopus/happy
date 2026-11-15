import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sleepComputerIfIdle } from "./computer-idle.js";
import {
  acquireComputerExecutionLease,
  ComputerBusyError,
  holdComputerExecutionLeaseForTakeover,
  provisionComputer,
  releaseComputerExecutionLease,
  renewComputerExecutionLease,
  replaceComputer,
} from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";
import {
  performComputerUpdate,
  queueComputerUpdate,
  reconcileComputerUpdates,
} from "./computer-update.js";
import { checkpointAndStopComputer, checkpointRunComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { takeoverContinuePlan } from "./takeover-resume.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("Team Computer takeover recovery (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let computerId: string;
  const address = `lease-${randomUUID()}@example.test`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    close = async () => {
      await prisma.messagingIdentity.deleteMany({ where: { address } });
      if (identity) {
        await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
        await prisma.user.deleteMany({ where: { id: identity.userId } });
      }
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    identity = await runAsSystem("lease fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    computerId = bot.computerId!;
  });

  afterAll(async () => close?.());

  it.each([
    "update",
    "start",
    "stop",
    "reconnect",
    "running",
    "vanished",
    "crashed",
    "lost",
    "unprepared",
  ] as const)(
    "does not save a half-restored replacement over the last good save (next %s)",
    async (next) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-unrestored-"));
      const sandbox = new FakeSandboxProvider();
      const home = new LocalAgentHomeStore(dataDir);
      const deps = {
        prisma,
        sandbox,
        home,
        jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
        events: { append: vi.fn() } as unknown as ThreadEvents,
        dataDir,
      };
      const context = {
        operationId: "update",
        traceId: "update",
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        signal: new AbortController().signal,
      } satisfies AdapterContext;
      const row = () => prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
      const homeFiles = async () => {
        const names: string[] = [];
        for await (const file of home.exportHome((await row()).homeKey, context))
          names.push(file.path);
        return names.sort();
      };
      // The restore stops after one file.
      const failRestore = () => {
        const importWorkspace = sandbox.importWorkspace.bind(sandbox);
        vi.spyOn(sandbox, "importWorkspace").mockImplementationOnce(async (ref, files, ctx) => {
          await importWorkspace(
            ref,
            (async function* () {
              for await (const file of files) {
                yield file;
                return;
              }
            })(),
            ctx,
          );
          throw new Error("restore interrupted");
        });
      };
      try {
        await prisma.computer.update({
          where: { id: computerId },
          data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
        });
        const first = await provisionComputer(deps, computerId, context);
        for (const name of ["a.txt", "b.txt"]) {
          await sandbox.writeFile(
            first,
            { path: name, content: new TextEncoder().encode(name) },
            context,
          );
        }
        await replaceComputer(deps, computerId, "update", context);
        expect(await homeFiles()).toEqual(["a.txt", "b.txt"]);

        if (next === "crashed" || next === "lost") {
          // The machine disappears and is recreated under the same name, and the worker dies
          // part-way through the restore, or inside the provider call before it returns, so no
          // failure handling runs.
          sandbox.boxes.delete(first.id);
          let importing!: () => void;
          const started = new Promise<void>((resolve) => {
            importing = resolve;
          });
          if (next === "lost") {
            const provision = sandbox.provision.bind(sandbox);
            vi.spyOn(sandbox, "provision").mockImplementationOnce(async (...args) => {
              await provision(...args);
              importing();
              return new Promise(() => undefined);
            });
          } else {
            const importWorkspace = sandbox.importWorkspace.bind(sandbox);
            vi.spyOn(sandbox, "importWorkspace").mockImplementationOnce(async (ref, files, ctx) => {
              await importWorkspace(
                ref,
                (async function* () {
                  for await (const file of files) {
                    yield file;
                    return;
                  }
                })(),
                ctx,
              );
              importing();
              await new Promise(() => undefined);
            });
          }
          void provisionComputer(deps, computerId, context);
          await started;
          await prisma.computer.update({
            where: { id: computerId },
            data: { updatedAt: new Date(0) },
          });
          // Reclaiming the abandoned start retries the restore; this one is interrupted too.
          failRestore();
          await expect(provisionComputer(deps, computerId, context)).rejects.toThrow();
        } else if (next === "unprepared") {
          // The machine disappears and is recreated under the same name, setting it up fails before
          // any restore, and it cannot be deleted.
          sandbox.boxes.delete(first.id);
          vi.spyOn(sandbox, "prepare").mockRejectedValueOnce(new Error("setup failed"));
          vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("provider deletion failed"));
          await expect(provisionComputer(deps, computerId, context)).rejects.toThrow();
        } else if (next === "vanished") {
          // The running machine disappears; the provider recreates it under the same name, the
          // restore fails, and the new machine cannot be deleted.
          sandbox.boxes.delete(first.id);
          failRestore();
          vi.spyOn(sandbox, "destroy").mockRejectedValueOnce(new Error("provider deletion failed"));
          await expect(provisionComputer(deps, computerId, context)).rejects.toThrow();
        } else {
          // The next update's restore fails, and the broken replacement cannot be deleted.
          failRestore();
          const destroy = sandbox.destroy.bind(sandbox);
          vi.spyOn(sandbox, "destroy")
            .mockImplementationOnce(destroy)
            .mockRejectedValueOnce(new Error("provider deletion failed"));
          await expect(replaceComputer(deps, computerId, "update", context)).rejects.toThrow();
        }
        expect(await row()).toMatchObject({
          state: "error",
          providerRef: first.providerRef,
          restorePending: true,
        });
        const { homeRevisionAt: savedAt } = await row();

        const expected = ["a.txt", "b.txt"];
        if (next === "start") {
          const started = await provisionComputer(deps, computerId, context);
          await sandbox.writeFile(
            started,
            { path: "c.txt", content: new TextEncoder().encode("c.txt") },
            context,
          );
          expected.push("c.txt");
        } else if (next === "stop") {
          const stopping = await row();
          await checkpointAndStopComputer(deps, stopping, toComputerRef(stopping), context);
          expect(await homeFiles()).toEqual(expected);
          expect(await row()).toMatchObject({ restorePending: true, homeRevisionAt: savedAt });
        } else if (next === "reconnect") {
          // A Reset that claimed it died, and the restore fails again on the reclaim.
          await prisma.computer.update({
            where: { id: computerId },
            data: { state: "suspending", updatedAt: new Date(0) },
          });
          failRestore();
          await expect(provisionComputer(deps, computerId, context)).rejects.toThrow();
          expect(await row()).toMatchObject({ state: "error", restorePending: true });
          // Idle sleep stops an abandoned claim on it without saving.
          await prisma.computer.update({
            where: { id: computerId },
            data: { state: "suspending", updatedAt: new Date(0) },
          });
          await sleepComputerIfIdle(deps, computerId);
          expect(await homeFiles()).toEqual(expected);
          expect(await row()).toMatchObject({
            state: "suspended",
            restorePending: true,
            homeRevisionAt: savedAt,
          });
        } else if (next === "crashed" || next === "lost") {
          const started = await provisionComputer(deps, computerId, context);
          expect([...sandbox.boxes.get(started.id)!.files.keys()].sort()).toEqual(expected);
          expect(await homeFiles()).toEqual(expected);
        } else if (next === "vanished") {
          const stopping = await row();
          await checkpointAndStopComputer(deps, stopping, toComputerRef(stopping), context);
          await prisma.computer.update({
            where: { id: computerId },
            data: { state: "suspending", updatedAt: new Date(0) },
          });
          await sleepComputerIfIdle(deps, computerId);
          expect(await homeFiles()).toEqual(expected);
          expect(await row()).toMatchObject({ restorePending: true, homeRevisionAt: savedAt });
          const started = await provisionComputer(deps, computerId, context);
          expect([...sandbox.boxes.get(started.id)!.files.keys()].sort()).toEqual(expected);
        } else if (next === "running") {
          // An older release running beside this one activated it without clearing the mark.
          await prisma.computer.update({ where: { id: computerId }, data: { state: "running" } });
          const started = await provisionComputer(deps, computerId, context);
          expect([...sandbox.boxes.get(started.id)!.files.keys()].sort()).toEqual(expected);
        }
        const replacement = await replaceComputer(deps, computerId, "update", context);
        expect(await homeFiles()).toEqual(expected);
        if (next === "update") expect((await row()).homeRevisionAt).toEqual(savedAt);
        expect([...sandbox.boxes.get(replacement.id)!.files.keys()].sort()).toEqual(expected);
      } finally {
        vi.restoreAllMocks();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["before", "during"] as const)(
    "does not save a run's export when a start that replaces and restores the machine began %s it",
    async (when) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-run-save-aba-"));
      const sandbox = new FakeSandboxProvider();
      const home = new LocalAgentHomeStore(dataDir);
      const deps = {
        prisma,
        sandbox,
        home,
        jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
        events: { append: vi.fn() } as unknown as ThreadEvents,
        dataDir,
      };
      const context = {
        operationId: "run",
        traceId: "run",
        spaceId: identity.spaceId,
        userId: identity.userId,
        botId: identity.botId,
        signal: new AbortController().signal,
      } satisfies AdapterContext;
      const { scope } = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
      const homeFiles = async (homeKey: string) => {
        const names: string[] = [];
        for await (const file of home.exportHome(homeKey, context)) names.push(file.path);
        return names.sort();
      };
      try {
        await prisma.computer.update({
          where: { id: computerId },
          data: {
            kind: "fake",
            scope: "dedicated",
            state: "stopped",
            providerRef: null,
            restorePending: false,
          },
        });
        const first = await provisionComputer(deps, computerId, context);
        for (const name of ["a.txt", "b.txt"]) {
          await sandbox.writeFile(
            first,
            { path: name, content: new TextEncoder().encode(name) },
            context,
          );
        }
        const running = await replaceComputer(deps, computerId, "update", context);
        const saved = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
        expect(await homeFiles(saved.homeKey)).toEqual(["a.txt", "b.txt"]);

        // The machine is lost and a start recreates it under the same name and restores it. The
        // start has either already claimed the computer when the run's save begins, or begins
        // during the export; the save streams the old machine's first file only.
        sandbox.boxes.delete(running.id);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const provision = sandbox.provision.bind(sandbox);
        const provisioning = vi
          .spyOn(sandbox, "provision")
          .mockImplementationOnce(async (...args) => {
            await gate;
            return provision(...args);
          });
        let start: Promise<unknown> | undefined;
        const begin = () => {
          start = provisionComputer(deps, computerId, context);
        };
        if (when === "before") {
          begin();
          await vi.waitFor(() => expect(provisioning).toHaveBeenCalled());
        }
        vi.spyOn(sandbox, "exportWorkspace").mockImplementationOnce(async function* () {
          yield { path: "a.txt", content: new TextEncoder().encode("a.txt") };
          if (!start) begin();
          release();
          await start;
        });
        await expect(
          checkpointRunComputerWorkspace(deps, saved, running, context),
        ).resolves.toBeUndefined();
        release();
        await start;

        const after = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
        expect(after).toMatchObject({
          state: "running",
          restorePending: false,
          homeRevision: saved.homeRevision,
        });
        expect(after.screenGeneration).not.toBe(saved.screenGeneration);
        expect(await homeFiles(saved.homeKey)).toEqual(["a.txt", "b.txt"]);
        expect([...sandbox.boxes.get(running.id)!.files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
      } finally {
        vi.restoreAllMocks();
        await prisma.computer.update({ where: { id: computerId }, data: { scope } });
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("does not let a stale-start reclaim activate a machine the start marked meanwhile", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-reclaim-marked-"));
    const sandbox = new FakeSandboxProvider();
    const home = new LocalAgentHomeStore(dataDir);
    const deps = {
      prisma,
      sandbox,
      home,
      jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const context = {
      operationId: "reclaim",
      traceId: "reclaim",
      spaceId: identity.spaceId,
      userId: identity.userId,
      botId: identity.botId,
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    try {
      await prisma.computer.update({
        where: { id: computerId },
        data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
      });
      const first = await provisionComputer(deps, computerId, context);
      for (const name of ["a.txt", "b.txt"]) {
        await sandbox.writeFile(
          first,
          { path: name, content: new TextEncoder().encode(name) },
          context,
        );
      }
      const running = await replaceComputer(deps, computerId, "update", context);
      // An older start claimed the computer long ago, the provider recreated its machine under
      // the same name, and only part of the restore has landed yet.
      sandbox.boxes.get(running.id)!.files.delete("b.txt");
      const stale = await prisma.computer.update({
        where: { id: computerId },
        data: { state: "booting", updatedAt: new Date(0) },
      });
      // That start marks the machine just after this reclaim last read the row.
      const findRun = prisma.run.findFirst.bind(prisma.run);
      vi.spyOn(prisma.run, "findFirst")
        .mockImplementationOnce(findRun)
        .mockImplementationOnce((async (args: Parameters<typeof findRun>[0]) => {
          await prisma.computer.update({
            where: { id: computerId },
            data: { restorePending: true, updatedAt: stale.updatedAt },
          });
          return findRun(args);
        }) as never);
      await expect(provisionComputer(deps, computerId, context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      vi.restoreAllMocks();
      expect(await prisma.computer.findUniqueOrThrow({ where: { id: computerId } })).toMatchObject({
        state: "booting",
        restorePending: true,
      });

      // The older start fails and leaves it marked; the next start restores it.
      await prisma.computer.update({ where: { id: computerId }, data: { state: "error" } });
      const restored = await provisionComputer(deps, computerId, context);
      expect([...sandbox.boxes.get(restored.id)!.files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    } finally {
      vi.restoreAllMocks();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("updates under its maintenance while a later run waits, but not while a run holds a lease", async () => {
    const { spaceId, botId, threadId, userId } = identity;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-maintenance-"));
    const deps = {
      prisma,
      sandbox: new FakeSandboxProvider(),
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const context = {
      operationId: "maintenance",
      traceId: "maintenance",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "queued" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "queued",
        trigger: "user",
      },
    });
    try {
      await prisma.computer.update({
        where: { id: computerId },
        data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
      });
      await provisionComputer(deps, computerId, context);
      await prisma.computer.update({
        where: { id: computerId },
        data: { maintenanceId: context.operationId },
      });
      await expect(
        acquireComputerExecutionLease(prisma, { computerId, botId, runId: run.id }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
      await expect(replaceComputer(deps, computerId, "update", context)).resolves.toBeTruthy();

      await prisma.computerExecutionLease.upsert({
        where: { computerId_botId: { computerId, botId } },
        create: {
          computerId,
          botId,
          runId: run.id,
          fence: 1,
          expiresAt: new Date(Date.now() + 60_000),
        },
        update: { runId: run.id, expiresAt: new Date(Date.now() + 60_000) },
      });
      await expect(replaceComputer(deps, computerId, "update", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    } finally {
      await prisma.computerExecutionLease.updateMany({
        where: { computerId },
        data: { expiresAt: new Date(0) },
      });
      await prisma.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      await prisma.computer.update({ where: { id: computerId }, data: { maintenanceId: null } });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lets a stale boot be reclaimed or reset past a background helper, but not past a turn", async () => {
    const { spaceId, botId, userId } = identity;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-helper-lifecycle-"));
    const deps = {
      prisma,
      sandbox: new FakeSandboxProvider(),
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const context = {
      operationId: "helper-lifecycle",
      traceId: "helper-lifecycle",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    const helperThread = await prisma.thread.create({
      data: { spaceId, userId, helperBotId: botId },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        botId,
        threadId: helperThread.id,
        userId,
        prompt: "fixture",
        status: "running",
      },
    });
    // A live run lease, as the executor heartbeat keeps on every running run.
    const helper = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId: helperThread.id,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "helper",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const abandonedBoot = () =>
      prisma.computer.update({
        where: { id: computerId },
        data: { kind: "fake", state: "booting", providerRef: null, updatedAt: new Date(0) },
      });
    // A start that is not refused waits for the abandoned boot like any start; stop it there.
    const startPastAbandonedBoot = async () => {
      const waiting = new AbortController();
      const outcome = provisionComputer(deps, computerId, {
        ...context,
        signal: waiting.signal,
      }).then(
        () => "started",
        (error: unknown) => (error instanceof ComputerBusyError ? "busy" : "waited"),
      );
      setTimeout(() => waiting.abort(), 1_000);
      return outcome;
    };
    try {
      await abandonedBoot();
      expect(await startPastAbandonedBoot()).not.toBe("busy");
      await abandonedBoot();
      await expect(replaceComputer(deps, computerId, "reset", context)).resolves.toBeTruthy();
      await expect(replaceComputer(deps, computerId, "reset", context)).resolves.toBeTruthy();

      // The same run as the bot's own turn still holds every one of them.
      await prisma.run.update({ where: { id: helper.id }, data: { trigger: "user" } });
      await abandonedBoot();
      expect(await startPastAbandonedBoot()).toBe("busy");
      await expect(replaceComputer(deps, computerId, "reset", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
      await prisma.computer.update({ where: { id: computerId }, data: { state: "running" } });
      await expect(replaceComputer(deps, computerId, "reset", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    } finally {
      await prisma.run.update({ where: { id: helper.id }, data: { status: "cancelled" } });
      await prisma.thread.delete({ where: { id: helperThread.id } });
      await prisma.computer.update({
        where: { id: computerId },
        data: { state: "stopped", providerRef: null, maintenanceId: null },
      });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("frees a computer a vanished update left booting, then recovers it", async () => {
    const { botId } = identity;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-abandoned-update-"));
    const jobs = { enqueue: vi.fn(async () => {}), cancel: vi.fn() } as unknown as JobPublisher;
    const deps = {
      prisma,
      sandbox: new FakeSandboxProvider(),
      home: new LocalAgentHomeStore(dataDir),
      jobs,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const update = await prisma.computerUpdate.create({
      data: {
        computerId,
        botId,
        status: "running",
        stage: "restoring",
        updatedAt: new Date(Date.now() - 2 * 60 * 60_000),
      },
    });
    const computer = () =>
      prisma.computer.findUniqueOrThrow({
        where: { id: computerId },
        select: { state: true, maintenanceId: true },
      });
    const status = async (id: string) =>
      (await prisma.computerUpdate.findUniqueOrThrow({ where: { id } })).status;
    try {
      // Teardown cleared the old machine before the dead worker started the new one.
      await prisma.computer.update({
        where: { id: computerId },
        data: {
          kind: "fake",
          state: "booting",
          providerRef: null,
          maintenanceId: update.id,
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
          controlBotId: null,
        },
      });
      await reconcileComputerUpdates(deps);
      expect(await status(update.id)).toBe("interrupted");
      // Marking it interrupted restarts the clock, so the next pass keeps it reserved.
      await reconcileComputerUpdates(deps);
      expect(await status(update.id)).toBe("interrupted");
      expect(await computer()).toEqual({ state: "booting", maintenanceId: update.id });

      await prisma.computerUpdate.update({
        where: { id: update.id },
        data: { updatedAt: new Date(Date.now() - 61 * 60_000) },
      });
      await reconcileComputerUpdates(deps);
      expect(await status(update.id)).toBe("failed");
      expect(await computer()).toEqual({ state: "error", maintenanceId: null });

      const recover = await queueComputerUpdate(deps, computerId, botId, "recover");
      await performComputerUpdate(deps, recover.id);
      expect(await status(recover.id)).toBe("completed");
      expect(await computer()).toEqual({ state: "running", maintenanceId: null });
    } finally {
      await prisma.computer.update({
        where: { id: computerId },
        data: { state: "stopped", providerRef: null, maintenanceId: null },
      });
      await prisma.computerUpdate.deleteMany({ where: { computerId } });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["suspending", "fake-old", "quarantined"],
    ["suspending", null, "error"],
    ["booting", null, "error"],
    ["running", "fake-old", "running"],
    ["stopped", null, "stopped"],
    ["quarantined", "fake-old", "quarantined"],
    ["error", "fake-old", "error"],
  ] as const)(
    "releases a %s computer with machine %s left by a vanished update as %s",
    async (left, providerRef, expected) => {
      const jobs = { enqueue: vi.fn(async () => {}), cancel: vi.fn() } as unknown as JobPublisher;
      const update = await prisma.computerUpdate.create({
        data: {
          computerId,
          botId: identity.botId,
          status: "interrupted",
          stage: "saving",
          updatedAt: new Date(Date.now() - 61 * 60_000),
        },
      });
      try {
        await prisma.computer.update({
          where: { id: computerId },
          data: {
            state: left,
            providerRef,
            maintenanceId: update.id,
            controlHolder: "none",
            controlLeaseId: null,
            controlLeaseExpiresAt: null,
            controlBotId: null,
          },
        });
        await reconcileComputerUpdates({ prisma, jobs });
        await expect(
          prisma.computer.findUniqueOrThrow({
            where: { id: computerId },
            select: { state: true, maintenanceId: true },
          }),
        ).resolves.toEqual({ state: expected, maintenanceId: null });
        await expect(
          queueComputerUpdate({ prisma, jobs }, computerId, identity.botId, "recover"),
        ).resolves.toMatchObject({ status: "queued" });
      } finally {
        await prisma.computer.update({
          where: { id: computerId },
          data: { state: "stopped", providerRef: null, maintenanceId: null },
        });
        await prisma.computerUpdate.deleteMany({ where: { computerId } });
      }
    },
  );

  it("leaves a computer another operation reserved alone", async () => {
    const jobs = { enqueue: vi.fn(async () => {}), cancel: vi.fn() } as unknown as JobPublisher;
    const update = await prisma.computerUpdate.create({
      data: {
        computerId,
        botId: identity.botId,
        status: "interrupted",
        stage: "saving",
        updatedAt: new Date(Date.now() - 61 * 60_000),
      },
    });
    try {
      await prisma.computer.update({
        where: { id: computerId },
        data: { state: "suspending", providerRef: "fake-old", maintenanceId: "later-operation" },
      });
      await reconcileComputerUpdates({ prisma, jobs });
      expect(
        (await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } })).status,
      ).toBe("failed");
      await expect(
        prisma.computer.findUniqueOrThrow({
          where: { id: computerId },
          select: { state: true, maintenanceId: true },
        }),
      ).resolves.toEqual({ state: "suspending", maintenanceId: "later-operation" });
    } finally {
      await prisma.computer.update({
        where: { id: computerId },
        data: { state: "stopped", providerRef: null, maintenanceId: null },
      });
      await prisma.computerUpdate.deleteMany({ where: { computerId } });
    }
  });

  it("leaves an update queued when the deletion claim lands before its replacement", async () => {
    const { spaceId, botId, userId } = identity;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-deleting-pause-"));
    const sandbox = new FakeSandboxProvider();
    // The claim commits after the update is claimed, before the replacement claims the computer.
    let claimed = false;
    const computers = new Proxy(prisma.computer, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "findUniqueOrThrow" && !claimed)
          return async (...args: unknown[]) => {
            claimed = true;
            await prisma.space.update({
              where: { id: spaceId },
              data: {
                deletingAt: new Date(),
                deletionClaimId: `organization-deletion:${spaceId}:x`,
              },
            });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const client = Object.create(prisma, { computer: { value: computers } }) as PrismaClient;
    client.$transaction = prisma.$transaction.bind(prisma) as PrismaClient["$transaction"];
    const deps = {
      prisma: client,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const context = {
      operationId: "deleting-pause",
      traceId: "deleting-pause",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    try {
      await prisma.computer.update({
        where: { id: computerId },
        data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
      });
      await provisionComputer({ ...deps, prisma }, computerId, context);
      const update = await prisma.computerUpdate.create({
        data: { computerId, botId, action: "recover" },
      });
      const destroy = vi.spyOn(sandbox, "destroy");

      await performComputerUpdate(deps, update.id);

      expect(destroy).not.toHaveBeenCalled();
      // Calling the deletion off lets reconciliation run it as if it had never started.
      await expect(
        prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
      ).resolves.toMatchObject({ status: "queued" });
    } finally {
      await prisma.space.update({
        where: { id: spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
      await prisma.computerUpdate.deleteMany({ where: { computerId } });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["reset", "update"] as const)(
    "does not %s a computer when the deletion claim commits while it waits for the row",
    async (operation) => {
      const { spaceId, botId, userId } = identity;
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-deleting-race-"));
      const sandbox = new FakeSandboxProvider();
      const deps = {
        prisma,
        sandbox,
        home: new LocalAgentHomeStore(dataDir),
        jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn() } as unknown as JobPublisher,
        events: { append: vi.fn() } as unknown as ThreadEvents,
        dataDir,
      };
      const context = {
        operationId: `deleting-race-${operation}`,
        traceId: `deleting-race-${operation}`,
        spaceId,
        userId,
        botId,
        signal: new AbortController().signal,
      } satisfies AdapterContext;
      /** Opens a transaction that runs `hold`, then waits until `release` to commit. */
      const held = (hold: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        let ready!: () => void;
        let release!: () => void;
        const holding = new Promise<void>((done) => {
          ready = done;
        });
        const released = new Promise<void>((done) => {
          release = done;
        });
        const committed = prisma.$transaction(
          async (tx) => {
            await hold(tx);
            ready();
            await released;
          },
          { timeout: 30_000 },
        );
        return { holding, release, committed };
      };
      const pause = () => new Promise((done) => setTimeout(done, 300));
      try {
        await prisma.computer.update({
          where: { id: computerId },
          data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
        });
        await provisionComputer(deps, computerId, context);
        const update = await prisma.computerUpdate.create({
          data: { computerId, botId, action: "recover" },
        });
        const destroy = vi.spyOn(sandbox, "destroy");
        const row = held((tx) =>
          operation === "reset"
            ? tx.$queryRaw`SELECT id FROM computers WHERE id = ${computerId} FOR UPDATE`
            : tx.$queryRaw`SELECT id FROM computer_updates WHERE id = ${update.id} FOR UPDATE`,
        );
        await row.holding;
        const claim = held(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"`;
          await tx.space.update({
            where: { id: spaceId },
            data: { deletingAt: new Date(), deletionClaimId: `organization-deletion:${spaceId}:x` },
          });
        });
        await claim.holding;
        const working = (
          operation === "reset"
            ? replaceComputer(deps, computerId, "reset", context)
            : performComputerUpdate(deps, update.id)
        ).catch(() => undefined);
        await pause();
        claim.release();
        await claim.committed;
        await pause();
        row.release();
        await row.committed;
        await working;

        expect(destroy).not.toHaveBeenCalled();
        // The update is left for the deletion, not claimed and failed.
        await expect(
          prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
        ).resolves.toMatchObject({ status: "queued" });
      } finally {
        await prisma.space.update({
          where: { id: spaceId },
          data: { deletingAt: null, deletionClaimId: null },
        });
        await prisma.computerUpdate.deleteMany({ where: { computerId } });
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it("neither updates nor replaces a computer in a Space that is being deleted", async () => {
    const { spaceId, botId, userId } = identity;
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-deleting-"));
    const sandbox = new FakeSandboxProvider();
    const deps = {
      prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn() } as unknown as JobPublisher,
      events: { append: vi.fn() } as unknown as ThreadEvents,
      dataDir,
    };
    const context = {
      operationId: "deleting-update",
      traceId: "deleting-update",
      spaceId,
      userId,
      botId,
      signal: new AbortController().signal,
    } satisfies AdapterContext;
    try {
      await prisma.computer.update({
        where: { id: computerId },
        data: { kind: "fake", state: "stopped", providerRef: null, restorePending: false },
      });
      const ref = await provisionComputer(deps, computerId, context);
      const update = await prisma.computerUpdate.create({
        data: { computerId, botId, action: "recover" },
      });
      await prisma.space.update({
        where: { id: spaceId },
        data: { deletingAt: new Date(), deletionClaimId: `organization-deletion:${spaceId}:x` },
      });
      const destroy = vi.spyOn(sandbox, "destroy");

      await performComputerUpdate(deps, update.id);
      await expect(replaceComputer(deps, computerId, "reset", context)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );

      await expect(
        prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
      ).resolves.toMatchObject({ status: "queued" });
      expect(destroy).not.toHaveBeenCalled();
      await expect(
        prisma.computer.findUniqueOrThrow({ where: { id: computerId } }),
      ).resolves.toMatchObject({ providerRef: ref.providerRef });
    } finally {
      await prisma.space.update({
        where: { id: spaceId },
        data: { deletingAt: null, deletionClaimId: null },
      });
      await prisma.computerUpdate.deleteMany({ where: { computerId } });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("lets API operations acquire new or expired leases without a worker claim", async () => {
    const input = { computerId, botId: identity.botId, runId: "boot:fixture" };
    const first = await acquireComputerExecutionLease(prisma, input);
    expect(first).not.toBeNull();
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(true);

    // Neither the same operation nor a different API operation may steal a live lease.
    for (const runId of [input.runId, "teach:fixture", "reset:fixture"]) {
      await expect(
        acquireComputerExecutionLease(prisma, { ...input, runId }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    }
    const held = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId: identity.botId } },
    });
    expect(held.fence).toBe(first!.fence);
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);

    await releaseComputerExecutionLease(prisma, first);
    const next = await acquireComputerExecutionLease(prisma, { ...input, runId: "teach:fixture" });
    expect(next).toMatchObject({ runId: "teach:fixture", fence: first!.fence + 1 });
    await expect(renewComputerExecutionLease(prisma, first)).resolves.toBe(false);
    await releaseComputerExecutionLease(prisma, next);
  });

  it("recovers a hold written before waiting_takeover without letting another run steal it", async () => {
    const { spaceId, botId, threadId, userId } = identity;
    const task = await prisma.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "fixture", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const input = { computerId, botId, runId: run.id, workerId: "worker-1", runFence: 1 };
    const first = await acquireComputerExecutionLease(prisma, input);
    expect(first).not.toBeNull();
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(true);
    const held = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId } },
    });
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);

    const other = await prisma.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-3",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const otherInput = { ...input, runId: other.id, workerId: "worker-3" };
    await expect(acquireComputerExecutionLease(prisma, otherInput)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );

    // API operations also cannot steal a live worker lease, even with its run id.
    for (const runId of [run.id, "boot:fixture"]) {
      await expect(
        acquireComputerExecutionLease(prisma, { computerId, botId, runId }),
      ).rejects.toBeInstanceOf(ComputerBusyError);
    }

    // Simulate recovery claiming the expired run after a hard kill, before the pause committed.
    await prisma.run.update({
      where: { id: run.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const observed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(takeoverContinuePlan(observed).heldForTakeover).toBe(false);
    const claimed = await prisma.run.updateMany({
      where: { id: run.id, status: "running", leaseExpiresAt: { lte: new Date() } },
      data: {
        leaseOwner: "worker-2",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(claimed.count).toBe(1);
    const recoveryInput = { ...input, workerId: "worker-2", runFence: 2 };
    const recovered = await acquireComputerExecutionLease(prisma, recoveryInput);
    expect(recovered).toMatchObject({ runId: run.id, fence: first!.fence + 1 });
    await expect(renewComputerExecutionLease(prisma, first)).resolves.toBe(false);
    await expect(holdComputerExecutionLeaseForTakeover(prisma, first)).resolves.toBe(false);
    await releaseComputerExecutionLease(prisma, first);

    for (const stale of [
      input,
      { ...recoveryInput, workerId: "worker-1" },
      { ...recoveryInput, runFence: 1 },
    ]) {
      await expect(acquireComputerExecutionLease(prisma, stale)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    }
    // A concurrent claim keeps ownership locked until acquisition commits.
    await prisma.$transaction(async (tx) => {
      await tx.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
      await expect(acquireComputerExecutionLease(prisma, recoveryInput)).rejects.toBeInstanceOf(
        ComputerBusyError,
      );
    });
    const active = await prisma.computerExecutionLease.findUniqueOrThrow({
      where: { computerId_botId: { computerId, botId } },
    });
    expect(active.fence).toBe(recovered!.fence);
    expect(active.expiresAt.getTime()).toBeLessThan(Date.now() + 6 * 60_000);
    await expect(acquireComputerExecutionLease(prisma, otherInput)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    await expect(renewComputerExecutionLease(prisma, recovered)).resolves.toBe(true);
    await releaseComputerExecutionLease(prisma, recovered);
    await expect(acquireComputerExecutionLease(prisma, otherInput)).resolves.toMatchObject({
      runId: other.id,
      fence: recovered!.fence + 1,
    });
  });
});
