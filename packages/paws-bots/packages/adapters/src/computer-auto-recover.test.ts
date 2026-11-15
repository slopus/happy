import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as TimersPromises from "node:timers/promises";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import { SandboxDamagedError } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBoatApi, fakeBoatProvider } from "./boat-sandbox.test-support.js";
import { provisionComputer } from "./computer-lifecycle.js";
import { LocalAgentHomeStore } from "./home.js";

// Boat's polling waits advance a virtual clock instead of sleeping.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async (ms = 0) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

const context = {
  operationId: "auto-recover",
  traceId: "auto-recover",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
const text = (content: Uint8Array) => new TextDecoder().decode(content);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * A running Boat computer whose last save holds `saved.txt`, and whose Boat snapshot holds
 * `snapshot.txt` from a minute later. Then Boat's storage breaks under it.
 */
async function damagedComputer(damage: "resume_heals" | "persists" = "resume_heals") {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-auto-recover-"));
  roots.push(root);
  // The adapter binds the API's methods when it is built, so spy first.
  const stop = vi.spyOn(FakeBoatApi.prototype, "stop");
  const resume = vi.spyOn(FakeBoatApi.prototype, "resume");
  const api = new FakeBoatApi();
  const sandbox = fakeBoatProvider(api);
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  const write = (name: string) =>
    sandbox.writeFile(first, { path: name, content: new TextEncoder().encode(name) }, context);
  await home.writeFile("bot", "saved.txt", "saved.txt", context);
  await write("saved.txt");
  const homeRevisionAt = new Date();
  vi.setSystemTime(Date.now() + 60_000);
  await write("snapshot.txt");
  api.saveSnapshot(first.id);
  vi.setSystemTime(Date.now() + 60_000);
  await write("unreadable.txt");
  api.damage(first.id, damage);
  stop.mockClear();
  resume.mockClear();

  const row = {
    id: "computer",
    spaceId: "space",
    userId: "user",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    providerRef: first.providerRef as string | null,
    kind: "boat",
    controlHolder: "none",
    controlLeaseId: null,
    maintenanceId: null as string | null,
    homeRevision: "saved",
    homeRevisionAt,
    autoRecoveredAt: null as Date | null,
    runningSince: new Date(0),
    updatedAt: new Date(),
  };
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const matches = ["id", "state", "providerRef", "kind", "updatedAt"].every(
        (key) => !(key in where) || where[key] === row[key as keyof typeof row],
      );
      if (!matches) return { count: 0 };
      Object.assign(row, { updatedAt: new Date(row.updatedAt.getTime() + 1) }, data);
      return { count: 1 };
    }),
  };
  const deps = {
    prisma: {
      computer,
      computerExecutionLease: { findFirst: vi.fn().mockResolvedValue(null) },
      computerRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      run: { findFirst: vi.fn().mockResolvedValue(null) },
      space: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { api, deps, row, first, stop, resume };
}

function recoverySteps(sink: ReturnType<typeof createTestSink>) {
  return sink.events
    .filter((event) => event.message === "computer.auto_recover")
    .map((event) => [event.level, event.step]);
}

describe("a computer whose system is damaged", () => {
  it("is stopped to its provider's last good snapshot and started again", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const { api, deps, row, first, stop } = await damagedComputer();

    const ref = await provisionComputer(deps, row.id, context);

    expect(ref).toMatchObject({ providerRef: first.providerRef, fresh: false, started: true });
    expect(stop).toHaveBeenLastCalledWith(
      { sandboxId: first.id, stopRequest: { force: true } },
      expect.anything(),
    );
    expect(api.state(first.id)).toBe("ready");
    expect(text(await deps.sandbox.readFile(ref, "snapshot.txt", context))).toBe("snapshot.txt");
    await expect(deps.sandbox.readFile(ref, "unreadable.txt", context)).rejects.toThrow();
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    expect(row.autoRecoveredAt).toBeInstanceOf(Date);
    expect(recoverySteps(sink)).toEqual([
      ["warn", "stop"],
      ["warn", "recovered"],
    ]);
  });

  it("is replaced from its saved workspace when that is newer than the provider's snapshot", async () => {
    const { api, deps, row, first } = await damagedComputer();
    row.homeRevisionAt = new Date();

    const ref = await provisionComputer(deps, row.id, context);

    expect(ref.fresh).toBe(true);
    expect(ref.providerRef).not.toBe(first.providerRef);
    expect(text(await deps.sandbox.readFile(ref, "saved.txt", context))).toBe("saved.txt");
    await expect(deps.sandbox.readFile(ref, "snapshot.txt", context)).rejects.toThrow();
    expect(row).toMatchObject({ state: "running", providerRef: ref.providerRef });
    // The older copy is stopped, not deleted.
    expect(api.state(first.id)).toBe("archived");
  });

  it("is replaced by one new computer when the one it just created is damaged", async () => {
    // The adapter binds the API when it is built, so the spy goes on the prototype first.
    const create = FakeBoatApi.prototype.create;
    let created = 0;
    vi.spyOn(FakeBoatApi.prototype, "create").mockImplementation(async function (
      this: FakeBoatApi,
      request,
    ) {
      const response = await create.call(this, request);
      // The first create is the fixture's own computer; the next is the one provisioning makes.
      if (++created === 2) this.damage(response.sandbox.id);
      return response;
    });
    const { api, deps, row, first } = await damagedComputer();
    api.delete(first.id);
    const destroy = vi.spyOn(deps.sandbox, "destroy");

    const ref = await provisionComputer(deps, row.id, context);

    expect(created).toBe(3);
    expect(destroy).toHaveBeenCalledOnce();
    expect(ref.fresh).toBe(true);
    expect(row.providerRef).toBe(ref.providerRef);
    expect(text(await deps.sandbox.readFile(ref, "saved.txt", context))).toBe("saved.txt");
  });

  it("is left to Recover when it comes back damaged, without trying again", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    const { deps, row, first, stop, resume } = await damagedComputer("persists");

    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      SandboxDamagedError,
    );
    expect(recoverySteps(sink)).toEqual([
      ["warn", "stop"],
      ["warn", "failed"],
    ]);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const stops = stop.mock.calls.length;
    const resumes = resume.mock.calls.length;
    expect(stops).toBeGreaterThan(0);
    expect(resumes).toBe(1);

    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      SandboxDamagedError,
    );
    expect(stop).toHaveBeenCalledTimes(stops);
    expect(resume).toHaveBeenCalledTimes(resumes);
    expect(recoverySteps(sink)).toHaveLength(2);
  });

  it("is recovered again once a save after the last recovery shows it worked", async () => {
    const { deps, row } = await damagedComputer();
    row.autoRecoveredAt = new Date(row.homeRevisionAt.getTime() - 60_000);

    await expect(provisionComputer(deps, row.id, context)).resolves.toMatchObject({
      started: true,
    });
    expect(row.autoRecoveredAt.getTime()).toBeGreaterThan(row.homeRevisionAt.getTime());
  });
});
