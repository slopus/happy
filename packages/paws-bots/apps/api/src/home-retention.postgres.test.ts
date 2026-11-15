import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { EmailEmulator, ObjectAgentHomeStore, PrismaAgentHomeRecords } from "@rakazo/adapters";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { asSystem, ContentKeyRing, createDb, LocalKeyProvider } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryObjectStorage } from "../../../packages/adapters/src/object-storage.test-support.js";
import { homeRetentionSweep } from "./home-retention.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

describePostgres("saved home retention (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let root: string;
  let storage: MemoryObjectStorage;
  let home: ObjectAgentHomeStore;
  let email: EmailEmulator;
  let errors: unknown[];
  let id: string;
  let docker: string;
  let now: number;
  const context: AdapterContext = {
    operationId: "test",
    traceId: "test",
    spaceId: "test",
    userId: "test",
    signal: new AbortController().signal,
  };
  const sweep = (signal = new AbortController().signal) =>
    homeRetentionSweep({
      prisma,
      email,
      appUrl: "https://app.example.test/app",
      onError: (error) => errors.push(error),
    })(signal);
  const travel = (days: number) => {
    now += days * DAY;
    vi.setSystemTime(now);
  };
  const computer = () => system.computer.findUniqueOrThrow({ where: { id } });
  /** The stored objects left once the worker's storage sweep has removed unowned ones. */
  const objects = async () => {
    await home.sweep();
    const storageId = (await system.computer.findUniqueOrThrow({ where: { id: docker } }))
      .homeStorageId;
    return [...storage.objects.keys()].filter((key) => !key.includes(`/${storageId}/`));
  };
  const sent = () => email.sent.filter((message) => message.to === `${id}@rakazo.test`);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  beforeEach(async () => {
    now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    id = `retention-${randomBytes(6).toString("hex")}`;
    docker = `${id}-docker`;
    root = await mkdtemp(path.join(tmpdir(), "rakazo-retention-"));
    storage = new MemoryObjectStorage();
    home = new ObjectAgentHomeStore(root, storage, new PrismaAgentHomeRecords(system, ring()));
    email = new EmailEmulator();
    errors = [];
    await system.user.create({
      data: { id, name: "Alex", email: `${id}@rakazo.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
    await system.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Mine", isDefault: true } });
    await system.computer.create({
      data: {
        id,
        spaceId: id,
        userId: id,
        scopeKey: id,
        homeKey: id,
        kind: "fake",
        providerRef: `sandbox-${id}`,
        state: "stopped",
        createdAt: new Date(now - 100 * DAY),
      },
    });
    const files = await mkdtemp(path.join(tmpdir(), "rakazo-retention-files-"));
    await writeFile(path.join(files, "notes.md"), "keep me");
    await home.commit(id, files, context);
    await system.computer.update({
      where: { id },
      data: { homeRevision: "rev-1", homeRevisionAt: new Date(now - 100 * DAY) },
    });
    // A Docker computer works in a host's copy that its stored home backs up, so it is kept.
    await system.computer.create({
      data: {
        id: docker,
        spaceId: id,
        userId: id,
        scopeKey: docker,
        homeKey: docker,
        kind: "docker",
        state: "stopped",
        createdAt: new Date(now - 100 * DAY),
      },
    });
    await home.commit(docker, files, context);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id: { startsWith: id } } });
    await rm(root, { recursive: true, force: true });
  });

  it("warns once, then deletes only the stored copy of an unused computer", async () => {
    await sweep();
    await sweep();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("unless you choose a plan");
    expect(await objects()).toHaveLength(1);

    travel(6);
    await sweep();
    expect(await objects()).toHaveLength(1);

    travel(3);
    await sweep();
    expect(errors).toEqual([]);
    expect(await objects()).toEqual([]);
    expect(await computer()).toMatchObject({
      providerRef: `sandbox-${id}`,
      homeStorageId: null,
      homeStorageRevision: null,
      homeRevision: "empty",
      homeRevisionAt: null,
    });
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
    expect(sent()).toHaveLength(1);
  });

  it("gives a cancelled plan 30 days and keeps the files once it resubscribes", async () => {
    await system.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `cus-${id}`,
        status: "active",
        paidAt: new Date(now - 200 * DAY),
      },
    });
    await sweep();
    expect(sent()).toHaveLength(0);

    await system.billingAccount.update({
      where: { organizationId: id },
      data: { status: "canceled", endedAt: new Date(now - 25 * DAY) },
    });
    await sweep();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.text).toContain("unless you resubscribe");

    await system.billingAccount.update({
      where: { organizationId: id },
      data: { status: "active", endedAt: null },
    });
    travel(9);
    await sweep();
    expect(await objects()).toHaveLength(1);
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
  });

  it.each([
    ["has no plan", false, "unless you choose a plan"],
    ["ended its plan", true, "unless you resubscribe"],
  ])(
    "warns the owner, not the computer's member, when the organization %s",
    async (_, paid, text) => {
      const owner = `${id}-owner`;
      await system.user.create({
        data: { id: owner, name: "Sam", email: `${owner}@rakazo.test`, emailVerified: true },
      });
      await system.member.update({ where: { id }, data: { role: "member" } });
      await system.member.create({
        data: {
          id: owner,
          organizationId: id,
          userId: owner,
          role: "owner",
          createdAt: new Date(),
        },
      });
      if (paid)
        await system.billingAccount.create({
          data: {
            organizationId: id,
            customerId: `cus-${id}`,
            status: "canceled",
            paidAt: new Date(now - 200 * DAY),
            endedAt: new Date(now - 100 * DAY),
          },
        });
      await sweep();
      expect(errors).toEqual([]);
      expect(sent()).toHaveLength(0);
      expect(email.sent.map((message) => message.to)).toEqual([`${owner}@rakazo.test`]);
      expect(email.sent[0]!.text).toContain(text);
    },
  );

  it("sends one warning for more computers than one batch", async () => {
    const extra = Array.from({ length: 501 }, (_, index) => `${id}-${index}`);
    await system.computer.createMany({
      data: extra.map((computerId) => ({
        id: computerId,
        spaceId: id,
        userId: id,
        scopeKey: computerId,
        homeKey: computerId,
        kind: "fake",
        state: "stopped",
        createdAt: new Date(now - 100 * DAY),
        homeStorageId: computerId,
        homeStorageKey: "unused",
      })),
    });
    await sweep();
    await sweep();
    expect(errors).toEqual([]);
    expect(sent()).toHaveLength(1);
    expect(
      await system.homeDeletionNotice.count({
        where: { computerId: { in: [id, ...extra] }, warnedAt: { not: null } },
      }),
    ).toBe(502);
  });

  it("keeps the files when the computer is used after the warning", async () => {
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(3);
    await system.computerRun.create({
      data: { computerId: id, kind: "fake", startedAt: new Date(now), endedAt: new Date(now) },
    });
    travel(6);
    await sweep();
    expect(await objects()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it("keeps the files when the computer saves after the warning", async () => {
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(3);
    await system.computer.update({ where: { id }, data: { homeRevisionAt: new Date(now) } });
    travel(6);
    await sweep();
    expect(await objects()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it("deletes the stored copy of a computer whose last start failed", async () => {
    await system.computer.update({ where: { id }, data: { state: "error" } });
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(9);
    await sweep();
    expect(errors).toEqual([]);
    expect(await objects()).toEqual([]);
  });

  it("leaves a desktop computer's stored copy alone", async () => {
    await system.computer.update({ where: { id }, data: { kind: "desktop" } });
    await sweep();
    travel(9);
    await sweep();
    expect(sent()).toHaveLength(0);
    expect(await objects()).toHaveLength(1);
  });

  it("keeps the files when credits are bought after the warning, even once spent", async () => {
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(3);
    await system.modelCreditAccount.create({
      data: {
        organizationId: id,
        mode: "credits",
        balanceMicros: 0n,
        lots: {
          create: {
            id: `lot-${id}`,
            amountMicros: 1_000_000n,
            availableMicros: 0n,
            createdAt: new Date(now),
          },
        },
      },
    });
    travel(6);
    await sweep();
    expect(errors).toEqual([]);
    expect(await objects()).toHaveLength(1);
  });

  it("never deletes without a delivered warning", async () => {
    email.failNextSends(1);
    await sweep();
    expect(errors).toHaveLength(1);
    travel(9);
    await sweep();
    expect(await objects()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it("neither warns nor deletes while the computer runs", async () => {
    await system.computer.update({ where: { id }, data: { state: "running" } });
    await sweep();
    expect(sent()).toHaveLength(0);
    await system.computer.update({ where: { id }, data: { state: "suspended" } });
    await sweep();
    expect(sent()).toHaveLength(1);

    await system.computer.update({ where: { id }, data: { state: "running" } });
    travel(9);
    await sweep();
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
    expect(await objects()).toHaveLength(1);
  });

  it("keeps the files of an organization still running bots on credits", async () => {
    await system.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `cus-${id}`,
        status: "canceled",
        paidAt: new Date(now - 200 * DAY),
        endedAt: new Date(now - 100 * DAY),
      },
    });
    await system.modelCreditAccount.create({
      data: { organizationId: id, mode: "credits", balanceMicros: 1_000_000n },
    });
    await sweep();
    travel(9);
    await sweep();
    expect(sent()).toHaveLength(0);
    expect(await objects()).toHaveLength(1);
  });

  it("keeps the files when a plan starts after the scan read the computer", async () => {
    await sweep();
    travel(9);
    const findMany = prisma.computer.findMany;
    const scan = vi.spyOn(prisma.computer, "findMany").mockImplementationOnce((async (
      args: Parameters<typeof findMany>[0],
    ) => {
      const rows = await findMany(args);
      await system.billingAccount.create({
        data: {
          organizationId: id,
          customerId: `cus-${id}`,
          status: "active",
          paidAt: new Date(),
        },
      });
      return rows;
    }) as never);
    await sweep();
    expect(scan).toHaveBeenCalled();
    scan.mockRestore();
    expect(errors).toEqual([]);
    expect((await computer()).homeStorageId).not.toBeNull();
    expect(await objects()).toHaveLength(1);
  });

  it("keeps the files when a payment commits while the deletion waits for it", async () => {
    await system.billingAccount.create({
      data: {
        organizationId: id,
        customerId: `cus-${id}`,
        status: "canceled",
        paidAt: new Date(now - 200 * DAY),
        endedAt: new Date(now - 100 * DAY),
      },
    });
    await sweep();
    expect(sent()).toHaveLength(1);
    travel(9);
    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let updated!: () => void;
    const pending = new Promise<void>((resolve) => {
      updated = resolve;
    });
    const payment = system.$transaction(
      async (tx) => {
        await tx.billingAccount.update({
          where: { organizationId: id },
          data: { status: "active", endedAt: null },
        });
        updated();
        await held;
      },
      { timeout: 20_000 },
    );
    await pending;
    const swept = sweep();
    for (;;) {
      const [{ waiting }] = await system.$queryRaw<[{ waiting: number }]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%billing_accounts%FOR SHARE%'`;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    commit();
    await payment;
    await swept;
    expect(errors).toEqual([]);
    expect((await computer()).homeStorageId).not.toBeNull();
    expect(await objects()).toHaveLength(1);
  });

  it("stops before warning once the sweep is aborted", async () => {
    const stopping = new AbortController();
    stopping.abort();
    await sweep(stopping.signal);
    expect(sent()).toHaveLength(0);
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
  });

  it("does not send a warning when the computer is used after the scan read it", async () => {
    const createMany = prisma.homeDeletionNotice.createMany;
    const queue = vi.spyOn(prisma.homeDeletionNotice, "createMany").mockImplementationOnce((async (
      args: Parameters<typeof createMany>[0],
    ) => {
      await system.computerRun.create({
        data: { computerId: id, kind: "fake", startedAt: new Date(), lastSeenAt: new Date() },
      });
      return createMany(args);
    }) as never);
    await sweep();
    expect(queue).toHaveBeenCalledOnce();
    queue.mockRestore();
    expect(errors).toEqual([]);
    expect(sent()).toHaveLength(0);
    expect(await system.homeDeletionNotice.count({ where: { computerId: id } })).toBe(0);
  });
});

function ring() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (keyId) => keys.find((row) => row.id === keyId),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}
