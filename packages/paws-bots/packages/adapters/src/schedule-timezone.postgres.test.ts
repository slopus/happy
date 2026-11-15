import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { changeUserTimezone, createScheduleFromTool } from "./schedule-tools.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner,
// as `pnpm test:integration` provides.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe
    : describe.skip;

/** A raw SQL monitor, as the owner pool's connections provide. */
type SqlMonitor = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ pid: number }> }>;
};

describePostgres("moving routines with the account timezone (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `tz-move-org-${suffix}`;
  const userId = `tz-move-user-${suffix}`;
  const otherUserId = `tz-move-other-${suffix}`;
  const spaces = ["a", "b"].map((name) => ({
    name,
    spaceId: `tz-move-space-${name}-${suffix}`,
    botId: `tz-move-bot-${name}-${suffix}`,
    threadId: `tz-move-thread-${name}-${suffix}`,
  }));
  let owner: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let app: ReturnType<typeof createDb>;
  const jobs = {
    enqueue: vi.fn(async () => undefined),
    enqueueIn: vi.fn(async () => undefined),
    cancelIn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };

  beforeAll(async () => {
    await runAsSystem("test fixture", seed);
    // Occurrences are built against this moment, whatever day the suite runs on. Only
    // Date is faked: the I/O and barrier waits below stay on real timers.
    vi.useFakeTimers({ now: new Date("2026-11-05T12:00:00.000Z"), toFake: ["Date"] });
  });

  async function seed() {
    owner = createDb(migrationUrl!);
    system = asSystem(owner.prisma);
    app = createDb(runtimeUrl!, { poolMax: 6 });
    const o = owner.prisma;
    await o.organization.create({
      data: { id: organizationId, name: "Tz", slug: organizationId, createdAt: new Date() },
    });
    for (const id of [userId, otherUserId]) {
      await o.user.create({
        data: {
          id,
          name: id,
          email: `${id}@rakazo.test`,
          emailVerified: true,
          timezone: "Africa/Cairo",
        },
      });
    }
    for (const space of spaces) {
      await o.space.create({ data: { id: space.spaceId, organizationId, name: space.name } });
      // Several bots per space: the move must cross bots as cheaply as one routine.
      for (const index of [0, 1, 2]) {
        const botId = index === 0 ? space.botId : `${space.botId}-${index}`;
        await o.bot.create({
          data: {
            id: botId,
            spaceId: space.spaceId,
            userId,
            name: `${space.name}${index}`,
            color: "#000",
          },
        });
        await o.thread.create({
          data: {
            id: index === 0 ? space.threadId : `${space.threadId}-${index}`,
            spaceId: space.spaceId,
            userId,
            botId,
          },
        });
      }
    }
  }

  afterAll(async () => {
    vi.useRealTimers();
    if (!owner) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  /** One active weekly routine at Monday 09:00 Africa/Cairo in the given space. */
  async function weeklyRoutine(
    space: (typeof spaces)[number],
    rowUserId: string,
    name: string,
    botIndex = 0,
  ) {
    return system.routine.create({
      data: {
        spaceId: space.spaceId,
        botId: `${space.botId}${botIndex === 0 ? "" : `-${botIndex}`}`,
        userId: rowUserId,
        name,
        prompt: "fixture",
        crons: ["0 9 * * 1"],
        timezone: "Africa/Cairo",
        notify: true,
        active: true,
        // A future Monday 09:00 Cairo relative to the frozen clock.
        nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
      },
    });
  }

  async function resetAccount() {
    await system.routine.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await system.user.update({ where: { id: userId }, data: { timezone: "Africa/Cairo" } });
    jobs.enqueue.mockClear();
  }

  /** One deadline for every poll of a barrier, inside the transactions' 20s budget. */
  const BARRIER_POLL_BUDGET_MS = 4_000;

  /**
   * Wait until PostgreSQL itself shows a session blocked on a lock `holder` holds, so a
   * barrier step proves SQL progress instead of assuming it from elapsed time. Returns
   * the blocked backend's pid; all polls of one barrier share its deadline.
   */
  async function waitForBlockedOn(
    monitor: SqlMonitor,
    holder: number,
    what: string,
    deadline: number,
  ): Promise<number> {
    while (performance.now() < deadline) {
      const { rows } = await monitor.query(
        "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pg_blocking_pids(pid) @> ARRAY[$1::int]",
        [holder],
      );
      if (rows.length > 0) return rows[0]!.pid;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what} to block on backend ${holder}`);
  }

  /** An operation set whose failures are handled at once and drained at cleanup. */
  function started() {
    const ops: Array<Promise<unknown>> = [];
    return {
      track: (op: Promise<unknown>) => {
        ops.push(
          op.then(
            () => undefined,
            () => undefined,
          ),
        );
        return op;
      },
      settle: () => Promise.allSettled(ops),
    };
  }

  /**
   * The runtime client with its interactive transactions given twenty seconds, so a
   * save sitting at a barrier cannot be expired by Prisma's five-second default. Only
   * this suite asks for that; production timeouts stay as they are.
   */
  const unhurried = () =>
    new Proxy(app.prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        const transaction = Reflect.get(target, "$transaction").bind(target) as (
          work: unknown,
          options?: Record<string, unknown>,
        ) => unknown;
        return (work: unknown, options?: Record<string, unknown>) =>
          transaction(work, { timeout: 20_000, ...options });
      },
    }) as PrismaClient;

  function save(userIdArg: string, timezone: string, space: (typeof spaces)[number]) {
    return runAsTenant({ spaceId: space.spaceId, userId }, () =>
      changeUserTimezone({ prisma: unhurried(), jobs }, userIdArg, timezone),
    );
  }

  it("moves the user's routines in every space, and only theirs", async () => {
    await resetAccount();
    const mine = [
      await weeklyRoutine(spaces[0]!, userId, "A"),
      await weeklyRoutine(spaces[1]!, userId, "B"),
    ];
    const foreign = await weeklyRoutine(spaces[0]!, otherUserId, "Other");

    // The save arrives while the user works in one space; the other space's routines
    // are invisible in that tenant scope.
    await save(userId, "Europe/London", spaces[0]!);

    const rows = await system.routine.findMany({
      where: { id: { in: [...mine.map((routine) => routine.id), foreign.id] } },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.timezone).toBe(row.userId === userId ? "Europe/London" : "Africa/Cairo");
    }
    for (const created of mine) {
      const row = rows.find((candidate) => candidate.id === created.id);
      expect(row?.nextRunAt?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
    }
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "routine.wakeup",
        payload: expect.objectContaining({ routineId: mine[0]!.id }),
      }),
    );
    await expect(
      system.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } }),
    ).resolves.toEqual({ timezone: "Europe/London" });
  });

  /** One active watch on its own interval in the given space; only its label moves. */
  async function watchRoutine(space: (typeof spaces)[number], botIndex: number, name: string) {
    return system.routine.create({
      data: {
        spaceId: space.spaceId,
        botId: `${space.botId}${botIndex === 0 ? "" : `-${botIndex}`}`,
        userId,
        name,
        prompt: "fixture",
        crons: [],
        timezone: "Africa/Cairo",
        notify: true,
        active: true,
        watch: { kind: "files", paths: ["inbox"], everyMinutes: 15 },
        nextRunAt: new Date("2026-11-06T12:00:00.000Z"),
      },
    });
  }

  it("moves routines spread across many bots, retimed rows and label-only rows", async () => {
    await resetAccount();
    const retimed: string[] = [];
    const relabeled: string[] = [];
    for (const space of spaces) {
      for (const index of [0, 1, 2]) {
        retimed.push(
          (await weeklyRoutine(space, userId, `Weekly ${space.name}${index}`, index)).id,
        );
        relabeled.push((await watchRoutine(space, index, `Watch ${space.name}${index}`)).id);
      }
    }

    await save(userId, "Europe/London", spaces[0]!);

    const rows = await system.routine.findMany({ where: { userId } });
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.timezone).toBe("Europe/London");
      if (retimed.includes(row.id)) {
        expect(row.nextRunAt?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
      } else {
        expect(row.nextRunAt?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
      }
    }
  });

  it("keeps every routine on the account's zone when two saves overlap", async () => {
    await resetAccount();
    await weeklyRoutine(spaces[0]!, userId, "A");
    await weeklyRoutine(spaces[1]!, userId, "B");

    // A barrier holds the user's routines. The first save blocks there, provably past
    // its account write (it holds the account row); the second save then blocks on that
    // row. Both overlap in the database, not by assumed timing; neither may strand the
    // routines on an intermediate zone.
    await runAsSystem("overlap barrier", async () => {
      const ops = started();
      const client = await app.pool.connect();
      const monitor = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query('SELECT id FROM routines WHERE "userId" = $1 FOR UPDATE', [userId]);
        const { rows: own } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
        const first = ops.track(save(userId, "Europe/London", spaces[0]!));
        const firstPid = await waitForBlockedOn(monitor, own[0]!.pid, "the first save", deadline);
        const second = ops.track(save(userId, "Asia/Tokyo", spaces[1]!));
        await waitForBlockedOn(monitor, firstPid, "the second save on the first", deadline);
        await client.query("COMMIT");
        await Promise.all([first, second]);
      } finally {
        // A failed step must not leave the barrier open, the saves wedged, or their
        // failures unhandled into the next test.
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        monitor.release();
        await ops.settle();
      }
    });

    const user = await system.user.findUniqueOrThrow({
      where: { id: userId },
      select: { timezone: true },
    });
    expect(["Europe/London", "Asia/Tokyo"]).toContain(user.timezone);
    const routines = await system.routine.findMany({ where: { userId } });
    expect(routines).toHaveLength(2);
    for (const routine of routines) {
      expect(routine.timezone).toBe(user.timezone);
    }
  });

  it("moves a routine a run claims while the save is in flight", async () => {
    await resetAccount();
    const routine = await weeklyRoutine(spaces[0]!, userId, "A");

    // A wakeup claim holds the routine row and advances its pending occurrence while
    // the zone save is between its read and its write. The claim runs as the job
    // system would, on the runtime login.
    const claimed = new Date("2026-11-16T07:00:00.000Z"); // next Monday 09:00 Cairo
    await runAsSystem("routine claim barrier", async () => {
      const ops = started();
      const client = await app.pool.connect();
      const monitor = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [routine.id]);
        const { rows: own } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
        const moving = ops.track(save(userId, "Europe/London", spaces[0]!));
        // Only once the save provably waits on the claimed row does the claim advance it.
        await waitForBlockedOn(monitor, own[0]!.pid, "the zone save", deadline);
        await client.query('UPDATE routines SET "nextRunAt" = $2 WHERE id = $1', [
          routine.id,
          // node-postgres serializes Date in the process local zone; nextRunAt is
          // TIMESTAMP without time zone, so a non-UTC host would store the local
          // wall time and drop the offset. An ISO string is zone-independent.
          claimed.toISOString(),
        ]);
        await client.query("COMMIT");
        await moving;
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        monitor.release();
        await ops.settle();
      }
    });

    const row = await system.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(row.timezone).toBe("Europe/London");
    // The claimed occurrence's local time holds: Monday 09:00 London.
    expect(row.nextRunAt?.toISOString()).toBe("2026-11-16T09:00:00.000Z");
  });

  it("moves a routine created from the account zone while the save is in flight", async () => {
    await resetAccount();
    const fixture = await weeklyRoutine(spaces[0]!, userId, "A");

    // The same barrier holds the fixture routine, so the zone save waits there while a
    // bot creates a routine that takes the account zone. The creation must itself wait
    // on the save's account row, proving the interleaving in the database: it must not
    // freeze the zone the save is replacing.
    await runAsSystem("creation barrier", async () => {
      const ops = started();
      const client = await app.pool.connect();
      const monitor = await owner.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [fixture.id]);
        const { rows: own } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
        const moving = ops.track(save(userId, "Europe/London", spaces[0]!));
        const movingPid = await waitForBlockedOn(monitor, own[0]!.pid, "the zone save", deadline);
        const created = ops.track(
          runAsTenant({ spaceId: spaces[0]!.spaceId, userId }, () =>
            createScheduleFromTool(
              {
                prisma: unhurried(),
                jobs,
                events: { append: async () => undefined },
              } as unknown as Parameters<typeof createScheduleFromTool>[0],
              {
                spaceId: spaces[0]!.spaceId,
                botId: spaces[0]!.botId,
                userId,
                threadId: spaces[0]!.threadId,
                name: "Fresh",
                prompt: "Check",
                schedule: { cron: "0 9 * * 1" },
              },
            ),
          ),
        );
        await waitForBlockedOn(monitor, movingPid, "the account-zone creation", deadline);
        await client.query("COMMIT");
        await Promise.all([moving, created]);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        monitor.release();
        await ops.settle();
      }
    });

    const rows = await system.routine.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.timezone).toBe("Europe/London");
      expect(row.nextRunAt?.toISOString()).toBe("2026-11-09T09:00:00.000Z");
    }
  });
});
