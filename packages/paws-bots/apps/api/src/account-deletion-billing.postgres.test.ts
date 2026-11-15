import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore, JobPublisher } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  runAsSystem,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteAccountContent } from "./account-deletion.js";
import { createBillingService } from "./billing.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds the provider's checkout call until the test releases it, so its lease stays held. */
class GatedCheckoutEmulator extends BillingEmulator {
  private readonly entered = deferred();
  private readonly gate = deferred();

  get providerCallStarted() {
    return this.entered.promise;
  }

  releaseCheckout() {
    this.gate.resolve();
  }

  override async createCheckout(input: { customerId: string; seats: number }) {
    this.entered.resolve();
    await this.gate.promise;
    return super.createCheckout(input as never);
  }
}

/** A provider whose cancellation always fails, so the account deletion aborts at billing. */
class FailingCancelEmulator extends BillingEmulator {
  override async cancelCustomerSubscriptions() {
    throw new Error("provider unavailable");
  }
}

describePostgres("account deletion billing ordering (PostgreSQL)", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userId = `acct-billing-${stamp}`;
  const email = `acct-billing-${stamp}@rakazo.test`;
  const organizationIds: string[] = [];
  let prisma: PrismaClient, db: ReturnType<typeof createDb>, root: string;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    root = await mkdtemp(path.join(tmpdir(), "rakazo-acct-billing-"));
    await asSystem(prisma).user.create({
      data: { id: userId, name: "Account billing", email, emailVerified: false },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(root, { recursive: true, force: true });
  });

  /** A personal organization of the account, addressed through its default space. */
  async function organization(name: string) {
    const organizationId = `acct-billing-${name}-${stamp}`;
    const spaceId = `acct-billing-${name}-space-${stamp}`;
    organizationIds.push(organizationId);
    const createdAt = new Date();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: `Account billing ${name}`,
        slug: organizationId,
        createdAt,
      },
    });
    await prisma.space.create({
      data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: {
        id: `acct-billing-${name}-member-${stamp}`,
        organizationId,
        userId,
        role: "owner",
        createdAt,
      },
    });
    const actor: Actor = { userId, spaceId, email, isDeploymentOwner: false };
    return { organizationId, actor };
  }

  function deletionDeps(billing: ReturnType<typeof createBillingService>) {
    return {
      prisma,
      sandbox: { destroy: vi.fn() },
      home: {},
      jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
      billing,
      events: createThreadEvents(prisma),
    } as unknown as SpaceDeletionDeps & {
      billing: ReturnType<typeof createBillingService>;
      events: ThreadEvents;
    };
  }

  it("refuses a checkout opened while the account's billing cancellation is still running", async () => {
    const second = await organization("second");
    const first = await organization("first");
    const provider = new GatedCheckoutEmulator({ namespace: `acct-billing-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    // One checkout is still opening for the second organization, holding its lease, so the
    // account's cancellation cannot finish while the test probes the first organization.
    const pending = service.checkout(second.actor);
    await provider.providerCallStarted;
    const deleting = runAsSystem("account deletion billing test", () =>
      deleteAccountContent(deletionDeps(service), userId),
    );
    // Wait until the deletion has claimed the account's spaces before probing.
    await vi.waitFor(async () => {
      const claimed = await prisma.space.findFirst({
        where: { organizationId: first.organizationId, deletingAt: { not: null } },
        select: { id: true },
      });
      expect(claimed).not.toBeNull();
    });
    // The first organization's cancellation has finished or is waiting behind the second one;
    // either way its spaces are claimed, so no payable checkout may open for it.
    await expect(service.checkout(first.actor)).rejects.toMatchObject({ code: "CONFLICT" });
    provider.releaseCheckout();
    await expect(pending).resolves.toMatchObject({ url: expect.any(String) });
    await deleting;
    for (const { organizationId } of [first, second])
      await expect(prisma.space.findFirst({ where: { organizationId } })).resolves.toBeNull();
  });

  it("rolls back only the claims this attempt took over", async () => {
    const earlier = await organization("earlier");
    const stale = await organization("stale");
    const fresh = await organization("freshroll");
    const accountClaim = `account-deletion:${userId}`;
    const staleMarker = `organization-deletion:${stale.organizationId}`;
    const staleAt = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS - 60_000);
    // A retry of a deletion that already failed mid-teardown, which handed its claim over, keeps
    // that claim; the stale marker belongs to a stalled organization deletion that may still
    // resume.
    await prisma.space.updateMany({
      where: { organizationId: earlier.organizationId },
      data: { deletionClaimId: accountClaim, deletingAt: new Date(0) },
    });
    await prisma.space.updateMany({
      where: { organizationId: stale.organizationId },
      data: { deletionClaimId: staleMarker, deletingAt: staleAt },
    });
    const service = createBillingService({
      prisma,
      provider: new FailingCancelEmulator({ namespace: `acct-billing-takeover-${stamp}` }),
      webOrigin: "https://example.test",
    });
    await expect(
      runAsSystem("account deletion billing test", () =>
        deleteAccountContent(deletionDeps(service), userId),
      ),
    ).rejects.toThrow("provider unavailable");
    await expect(
      prisma.space.findFirst({ where: { organizationId: earlier.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: accountClaim, deletingAt: expect.any(Date) });
    await expect(
      prisma.space.findFirst({ where: { organizationId: stale.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: staleMarker, deletingAt: staleAt });
    await expect(
      prisma.space.findFirst({ where: { organizationId: fresh.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: null, deletingAt: null });
  });

  it("undoes the account's claims when the billing cancellation fails", async () => {
    const only = await organization("rollback");
    const service = createBillingService({
      prisma,
      provider: new FailingCancelEmulator({ namespace: `acct-billing-fail-${stamp}` }),
      webOrigin: "https://example.test",
    });
    await expect(
      runAsSystem("account deletion billing test", () =>
        deleteAccountContent(deletionDeps(service), userId),
      ),
    ).rejects.toThrow("provider unavailable");
    await expect(
      prisma.space.findFirst({ where: { organizationId: only.organizationId } }),
    ).resolves.toMatchObject({ deletingAt: null, deletionClaimId: null });
    await expect(
      prisma.organization.findUnique({ where: { id: only.organizationId } }),
    ).resolves.not.toBeNull();
  });

  it("gives back the claims it took when another deletion holds a later space", async () => {
    const personal = await organization("conflictfirst");
    const work = await organization("conflictwork");
    // Another attempt is deleting the newer organization right now.
    await prisma.space.updateMany({
      where: { organizationId: work.organizationId },
      data: {
        deletionClaimId: `organization-deletion:${work.organizationId}:other`,
        deletingAt: new Date(),
      },
    });
    const billing = { cancelForDeletedUser: vi.fn() };
    try {
      await expect(
        runAsSystem("account deletion billing test", () =>
          deleteAccountContent(deletionDeps(billing as never), userId),
        ),
      ).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
      await expect(
        prisma.space.findFirst({ where: { organizationId: personal.organizationId } }),
      ).resolves.toMatchObject({ deletionClaimId: null, deletingAt: null });
      expect(billing.cancelForDeletedUser).not.toHaveBeenCalled();
    } finally {
      await prisma.space.updateMany({
        where: { organizationId: work.organizationId },
        data: { deletionClaimId: null, deletingAt: null },
      });
    }
  });

  it("refuses a second deletion of the account while the first holds its claims", async () => {
    const shared = await organization("parallel");
    const firstInBilling = deferred();
    const failFirst = deferred();
    const firstSettled = deferred();
    let calls = 0;
    // The first attempt's cancellation fails only once a second attempt has reached billing too,
    // and the second waits for the first to give its claims back before tearing anything down.
    const billing = {
      cancelForDeletedUser: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          firstInBilling.resolve();
          await failFirst.promise;
          throw new Error("provider unavailable");
        }
        failFirst.resolve();
        await firstSettled.promise;
      }),
    };
    const attempt = () =>
      runAsSystem("account deletion billing test", () =>
        deleteAccountContent(deletionDeps(billing as never), userId),
      );
    const first = attempt()
      .then(
        () => "fulfilled" as const,
        (error: unknown) => error,
      )
      .finally(firstSettled.resolve);
    await firstInBilling.promise;
    const second = await attempt().then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );
    failFirst.resolve();

    expect(second).toBeInstanceOf(SpaceDeletionInProgressError);
    await expect(first).resolves.toMatchObject({ message: "provider unavailable" });
    // The account stays as it was: nothing deleted, nothing left claimed.
    await expect(
      prisma.space.findFirst({ where: { organizationId: shared.organizationId } }),
    ).resolves.toMatchObject({ deletionClaimId: null, deletingAt: null });
  });

  it("hands its claims over when leaving other people's Spaces fails", async () => {
    const only = await organization("departure");
    // The first read of the account's memberships, when it leaves other people's Spaces, fails.
    let failed = false;
    const members = new Proxy(prisma.spaceMember, {
      get(target, key) {
        if (key === "findMany" && !failed)
          return async () => {
            failed = true;
            throw new Error("database unavailable");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const flaky = Object.create(prisma, { spaceMember: { value: members } }) as PrismaClient;
    flaky.$transaction = prisma.$transaction.bind(prisma) as PrismaClient["$transaction"];
    const billing = { cancelForDeletedUser: vi.fn() };
    const deps = () => ({ ...deletionDeps(billing as never), prisma: flaky });

    await expect(
      runAsSystem("account deletion billing test", () => deleteAccountContent(deps(), userId)),
    ).rejects.toThrow("database unavailable");
    // Deleting again right away resumes the claims instead of waiting for them to go stale.
    await runAsSystem("account deletion billing test", () => deleteAccountContent(deps(), userId));
    await expect(
      prisma.space.findFirst({ where: { organizationId: only.organizationId } }),
    ).resolves.toBeNull();
  });

  it.each(["billing", "teardown"] as const)(
    "keeps the claim of an attempt that took over an outlived one when that one fails in %s",
    async (stage) => {
      const only = await organization(`outlived-${stage}`);
      const firstWaiting = deferred();
      const failFirst = deferred();
      const secondInBilling = deferred();
      const finishSecond = deferred();
      let calls = 0;
      const billing = {
        cancelForDeletedUser: vi.fn(async () => {
          calls += 1;
          if (calls > 1) {
            secondInBilling.resolve();
            await finishSecond.promise;
          } else if (stage === "billing") {
            firstWaiting.resolve();
            await failFirst.promise;
            throw new Error("provider unavailable");
          }
        }),
      };
      // In teardown, the first attempt's read of the bots to destroy waits, then fails.
      let failed = false;
      const bots = new Proxy(prisma.bot, {
        get(target, key) {
          if (key === "findMany" && !failed)
            return async () => {
              failed = true;
              firstWaiting.resolve();
              await failFirst.promise;
              throw new Error("database unavailable");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const flaky = Object.create(prisma, { bot: { value: bots } }) as PrismaClient;
      flaky.$transaction = prisma.$transaction.bind(prisma) as PrismaClient["$transaction"];
      const attempt = (client: PrismaClient) =>
        runAsSystem("account deletion billing test", () =>
          deleteAccountContent({ ...deletionDeps(billing as never), prisma: client }, userId),
        ).then(
          () => "fulfilled" as const,
          (error: unknown) => error,
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const first = attempt(stage === "teardown" ? flaky : prisma);
        await firstWaiting.promise;
        // The first attempt outlives its claim, and a second one takes the claim over.
        vi.setSystemTime(Date.now() + SPACE_DELETION_CLAIM_TIMEOUT_MS + 60_000);
        const second = attempt(prisma);
        await secondInBilling.promise;
        failFirst.resolve();
        await expect(first).resolves.toBeInstanceOf(Error);
        const during = await prisma.space.findFirst({
          where: { organizationId: only.organizationId },
        });
        finishSecond.resolve();

        // While the second attempt still works, its claim is live.
        expect(during?.deletionClaimId).toBe(`account-deletion:${userId}`);
        expect(during?.deletingAt?.getTime()).toBeGreaterThan(
          Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS,
        );
        await expect(second).resolves.toBe("fulfilled");
        await expect(
          prisma.space.findFirst({ where: { organizationId: only.organizationId } }),
        ).resolves.toBeNull();
      } finally {
        failFirst.resolve();
        finishSecond.resolve();
        vi.useRealTimers();
      }
    },
  );

  /** The attempt's first `model.findMany` runs `wait` first; a rejection fails the read. */
  function withFirstRead(model: "space" | "bot", wait: () => Promise<void>): PrismaClient {
    let done = false;
    const delegate = new Proxy(prisma[model], {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "findMany" && !done)
          return async (...args: unknown[]) => {
            done = true;
            await wait();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const client = Object.create(prisma, { [model]: { value: delegate } }) as PrismaClient;
    client.$transaction = prisma.$transaction.bind(prisma) as PrismaClient["$transaction"];
    return client;
  }

  const settled = (attempt: Promise<void>) =>
    attempt.then(
      () => "fulfilled" as const,
      (error: unknown) => error,
    );

  it.each(["billing", "teardown"] as const)(
    "keeps the claim of an attempt started in the same millisecond when the other fails in %s",
    async (stage) => {
      const only = await organization(`same-ms-${stage}`);
      const firstWaiting = deferred();
      const failFirst = deferred();
      const secondReading = deferred();
      const resumeSecond = deferred();
      const secondInBilling = deferred();
      const finishSecond = deferred();
      let calls = 0;
      const billing = {
        cancelForDeletedUser: vi.fn(async () => {
          calls += 1;
          if (calls > 1) {
            secondInBilling.resolve();
            await finishSecond.promise;
          } else if (stage === "billing") {
            firstWaiting.resolve();
            await failFirst.promise;
            throw new Error("provider unavailable");
          }
        }),
      };
      const first =
        stage === "teardown"
          ? withFirstRead("bot", async () => {
              firstWaiting.resolve();
              await failFirst.promise;
              throw new Error("database unavailable");
            })
          : prisma;
      // The second attempt reads its candidates only after the first one's claim went stale.
      const second = withFirstRead("space", async () => {
        secondReading.resolve();
        await resumeSecond.promise;
      });
      const attempt = (client: PrismaClient) =>
        settled(
          runAsSystem("account deletion billing test", () =>
            deleteAccountContent({ ...deletionDeps(billing as never), prisma: client }, userId),
          ),
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const firstOutcome = attempt(first);
        await firstWaiting.promise;
        const secondOutcome = attempt(second);
        await secondReading.promise;
        vi.setSystemTime(Date.now() + SPACE_DELETION_CLAIM_TIMEOUT_MS + 60_000);
        resumeSecond.resolve();
        await secondInBilling.promise;
        failFirst.resolve();
        await expect(firstOutcome).resolves.toBeInstanceOf(Error);
        const during = await prisma.space.findFirst({
          where: { organizationId: only.organizationId },
        });
        finishSecond.resolve();

        expect(during?.deletionClaimId).toBe(`account-deletion:${userId}`);
        expect(during?.deletingAt?.getTime()).toBeGreaterThan(
          Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS,
        );
        await expect(secondOutcome).resolves.toBe("fulfilled");
      } finally {
        failFirst.resolve();
        resumeSecond.resolve();
        finishSecond.resolve();
        vi.useRealTimers();
      }
    },
  );

  it("refuses another attempt beside one whose candidate read outlasted the lease", async () => {
    const only = await organization("slow-read");
    const firstReading = deferred();
    const resumeFirst = deferred();
    const firstInBilling = deferred();
    const failFirst = deferred();
    let calls = 0;
    const billing = {
      cancelForDeletedUser: vi.fn(async () => {
        calls += 1;
        if (calls > 1) return;
        firstInBilling.resolve();
        await failFirst.promise;
        throw new Error("provider unavailable");
      }),
    };
    const first = withFirstRead("space", async () => {
      firstReading.resolve();
      await resumeFirst.promise;
    });
    const attempt = (client: PrismaClient) =>
      settled(
        runAsSystem("account deletion billing test", () =>
          deleteAccountContent({ ...deletionDeps(billing as never), prisma: client }, userId),
        ),
      );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const firstOutcome = attempt(first);
      await firstReading.promise;
      vi.setSystemTime(Date.now() + SPACE_DELETION_CLAIM_TIMEOUT_MS + 60_000);
      resumeFirst.resolve();
      await firstInBilling.promise;

      const second = await attempt(prisma);
      failFirst.resolve();

      expect(second).toBeInstanceOf(SpaceDeletionInProgressError);
      await expect(firstOutcome).resolves.toMatchObject({ message: "provider unavailable" });
      await expect(
        prisma.space.findFirst({ where: { organizationId: only.organizationId } }),
      ).resolves.toMatchObject({ deletionClaimId: null, deletingAt: null });
    } finally {
      failFirst.resolve();
      resumeFirst.resolve();
      vi.useRealTimers();
    }
  });
});
