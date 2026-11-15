import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactStore, JobPublisher } from "@rakazo/adapter-kit";
import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  billingAccountForOrganization,
  createDb,
  extendByokFreePeriod,
  FREE_MONTH_DAYS,
  keepOrganizationTrialUse,
  ownerHadTrial,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteOrganization } from "./account-deletion.js";
import { createBillingService, TRIAL_DAYS } from "./billing.js";
import { watchCheckoutLeaseClaims } from "./checkout-lease.test-support.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** One owner and their first two organizations, each addressed through its own space. */
async function ownerWithOrganizations(prisma: PrismaClient, stamp: string, name: string) {
  const userId = `trial-owner-${name}-${stamp}`;
  const email = `trial-owner-${name}-${stamp}@rakazo.test`;
  await prisma.user.create({
    data: { id: userId, name: `Trial owner ${name}`, email, emailVerified: false },
  });
  const organizations = await Promise.all(
    ["a", "b"].map(async (suffix) => {
      const organizationId = `trial-owner-${name}-${suffix}-${stamp}`;
      const spaceId = `trial-owner-${name}-${suffix}-space-${stamp}`;
      const createdAt = new Date();
      await prisma.organization.create({
        data: {
          id: organizationId,
          name: `Trial owner ${name} ${suffix}`,
          slug: organizationId,
          createdAt,
        },
      });
      await prisma.space.create({
        data: { id: spaceId, organizationId, name: "Personal", isDefault: true },
      });
      await prisma.member.create({
        data: {
          id: `trial-owner-${name}-${suffix}-member-${stamp}`,
          organizationId,
          userId,
          role: "owner",
          createdAt,
        },
      });
      const actor: Actor = { userId, spaceId, email, isDeploymentOwner: false };
      return { organizationId, actor };
    }),
  );
  return { userId, first: organizations[0]!, second: organizations[1]! };
}

dbTests("own-key trial across organizations", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const provider = new BillingEmulator({ modelCredits: true, namespace: `trial-owner-${stamp}` });
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  let prisma: PrismaClient,
    db: ReturnType<typeof createDb>,
    service: ReturnType<typeof createBillingService>;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function customerOf(organizationId: string) {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    return customerId;
  }

  async function ownerWith(name: string) {
    const owner = await ownerWithOrganizations(prisma, stamp, name);
    userIds.push(owner.userId);
    organizationIds.push(owner.first.organizationId, owner.second.organizationId);
    return owner;
  }

  it("keeps the trial for the same organization's reopened checkout", async () => {
    const owner = await ownerWith("reopen");
    await service.selectFunding(owner.first.actor, "byok");
    await service.selectFunding(owner.first.actor, "byok");
    const customerId = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(customerId)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("holds the owner's one trial while another organization's checkout is open", async () => {
    const owner = await ownerWith("hold");
    await service.selectFunding(owner.first.actor, "byok");
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    // The owner's one trial is held by the first organization's open session.
    await expect(service.status(owner.second.actor)).resolves.toMatchObject({
      trialAvailable: false,
    });
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
    provider.completeByokCheckout(first);
    provider.completeByokCheckout(second);
    await service.sync(first);
    await service.sync(second);
    // Only the first organization's subscription can be on a trial.
    await expect(provider.getCustomerSubscription(first)).resolves.toMatchObject({
      status: "trialing",
    });
    await expect(provider.getCustomerSubscription(second)).resolves.toMatchObject({
      status: "active",
      trialEndsAt: null,
    });
  });

  it("releases the hold once the checkout session has expired", async () => {
    const owner = await ownerWith("expire");
    await service.selectFunding(owner.first.actor, "byok");
    // The hold lasts as long as the session can be paid; after that it no longer counts.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { byokTrialCheckoutExpiresAt: new Date(Date.now() - 1000) },
    });
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("keeps free own-key days counted as the owner's used trial after the organization goes", async () => {
    const owner = await ownerWith("delete");
    // A free period granted before the owner-level mark existed.
    await prisma.modelCreditAccount.upsert({
      where: { organizationId: owner.first.organizationId },
      create: {
        organizationId: owner.first.organizationId,
        byokFreeUntil: new Date(Date.now() + FREE_MONTH_DAYS * 86_400_000),
      },
      update: {},
    });
    await keepOrganizationTrialUse(prisma, owner.first.organizationId);
    await prisma.organization.delete({ where: { id: owner.first.organizationId } });
    await expect(ownerHadTrial(prisma, owner.userId, "byok")).resolves.toBe(true);
    // Any subscription uses up every trial kind; free own-key days use up only the own-key one.
    await expect(ownerHadTrial(prisma, owner.userId, "managed")).resolves.toBe(false);
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("uses the trial up when free own-key days are granted, not only when they are kept", async () => {
    const owner = await ownerWith("grant");
    await prisma.$transaction(async (tx) => {
      await tx.modelCreditAccount.upsert({
        where: { organizationId: owner.second.organizationId },
        create: { organizationId: owner.second.organizationId },
        update: {},
      });
      await extendByokFreePeriod(tx, owner.second.organizationId, FREE_MONTH_DAYS);
    });
    // The organization's rows disappear without a billing-aware deletion, as when the last
    // member leaves an empty organization; the granted days still count as the used trial.
    await prisma.organization.delete({ where: { id: owner.second.organizationId } });
    await expect(ownerHadTrial(prisma, owner.userId, "byok")).resolves.toBe(true);
    await expect(ownerHadTrial(prisma, owner.userId, "managed")).resolves.toBe(false);
  });
});

/** A provider whose own-key checkout creation fails on demand. */
class FlakyByokEmulator extends BillingEmulator {
  failByokCheckout = false;

  constructor(namespace: string) {
    super({ modelCredits: true, namespace });
  }

  override async createByokCheckout(input: Parameters<BillingEmulator["createByokCheckout"]>[0]) {
    if (this.failByokCheckout) throw new Error("provider unavailable");
    return super.createByokCheckout(input);
  }
}

/**
 * Like a hosted provider, opening an own-key checkout first expires the customer's open
 * sessions, so a creation that then fails leaves none payable.
 */
class ExpiringFlakyByokEmulator extends FlakyByokEmulator {
  override async createByokCheckout(input: Parameters<BillingEmulator["createByokCheckout"]>[0]) {
    this.byokCheckouts.delete(input.customerId);
    return super.createByokCheckout(input);
  }
}

/** A provider whose cancellation fails on demand. */
class FlakyCancelEmulator extends BillingEmulator {
  failCancellation = false;

  constructor(namespace: string) {
    super({ modelCredits: true, namespace });
  }

  override async cancelCustomerSubscriptions(customerId: string) {
    if (this.failCancellation) throw new Error("provider unavailable");
    await super.cancelCustomerSubscriptions(customerId);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Holds the own-key checkout call until the test releases it. */
class DelayedByokEmulator extends BillingEmulator {
  private readonly entered = deferred();
  private readonly gate = deferred();

  constructor(namespace: string) {
    super({ modelCredits: true, namespace });
  }

  get byokCallStarted() {
    return this.entered.promise;
  }

  releaseByok() {
    this.gate.resolve();
  }

  override async createByokCheckout(input: Parameters<BillingEmulator["createByokCheckout"]>[0]) {
    this.entered.resolve();
    await this.gate.promise;
    return super.createByokCheckout(input);
  }
}

/** Holds the own-key checkout call at a gate, then fails it on demand. */
class GatedFailingByokEmulator extends BillingEmulator {
  private readonly entered = deferred();
  private readonly gate = deferred();
  fail = true;

  constructor(namespace: string) {
    super({ modelCredits: true, namespace });
  }

  get byokCallStarted() {
    return this.entered.promise;
  }

  failAndUngate() {
    this.gate.resolve();
  }

  override async createByokCheckout(input: Parameters<BillingEmulator["createByokCheckout"]>[0]) {
    this.entered.resolve();
    await this.gate.promise;
    if (this.fail) throw new Error("provider unavailable");
    return super.createByokCheckout(input);
  }
}

/**
 * Holds the next subscription read until the test lets it go, and fails own-key checkout
 * creation on demand, as an aborted call does.
 */
class GatedSyncEmulator extends FlakyByokEmulator {
  private readonly entered = deferred();
  private readonly gate = deferred();
  private armed = false;

  arm() {
    this.armed = true;
    return this.entered.promise;
  }

  release() {
    this.gate.resolve();
  }

  override async getCustomerSubscription(customerId: string) {
    if (this.armed) {
      this.armed = false;
      this.entered.resolve();
      await this.gate.promise;
    }
    return super.getCustomerSubscription(customerId);
  }
}

/** The provider as another request sees it, whose own-key checkout call fails. */
function failingByokCheckout(provider: BillingEmulator): BillingEmulator {
  return new Proxy(provider, {
    get(target, property) {
      if (property === "createByokCheckout")
        return async () => Promise.reject(new Error("provider unavailable"));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A database whose own-key hold extension fails, while every other write works. */
function extendFailingPrisma(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "user") return Reflect.get(target, property, receiver);
      return new Proxy(target.user, {
        get(user, method, receiver) {
          if (method !== "updateMany") return Reflect.get(user, method, receiver);
          return async (args: {
            data: {
              byokTrialCheckoutOrganizationId?: string | null;
              byokTrialCheckoutExpiresAt?: Date | null;
            };
          }) => {
            // The extension is the only hold write that touches the expiry alone.
            if (
              args.data.byokTrialCheckoutExpiresAt &&
              args.data.byokTrialCheckoutOrganizationId === undefined
            )
              throw new Error("db unavailable");
            return user.updateMany(args);
          };
        },
      });
    },
  });
}

dbTests("own-key trial hold lifecycle", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  let prisma: PrismaClient, db: ReturnType<typeof createDb>, root: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    root = await mkdtemp(path.join(tmpdir(), "rakazo-trial-hold-"));
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(root, { recursive: true, force: true });
  });

  async function ownerWith(name: string) {
    const owner = await ownerWithOrganizations(prisma, stamp, name);
    userIds.push(owner.userId);
    organizationIds.push(owner.first.organizationId, owner.second.organizationId);
    return owner;
  }

  async function customerOf(organizationId: string) {
    const { customerId } = (await billingAccountForOrganization(prisma, organizationId))!;
    return customerId;
  }

  it("gives the hold back when the provider refuses to create the session", async () => {
    const owner = await ownerWith("refuse");
    const provider = new FlakyByokEmulator(`hold-refuse-${stamp}`);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    provider.failByokCheckout = true;
    await expect(service.selectFunding(owner.first.actor, "byok")).rejects.toThrow(
      "provider unavailable",
    );
    provider.failByokCheckout = false;
    // The failed attempt left no payable session, so the owner's trial is free to take again.
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("frees the trial when a reopened checkout fails after the earlier session expired", async () => {
    const owner = await ownerWith("reopenfail");
    const provider = new ExpiringFlakyByokEmulator(`hold-reopen-${stamp}`);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.selectFunding(owner.first.actor, "byok");
    provider.failByokCheckout = true;
    await expect(service.selectFunding(owner.first.actor, "byok")).rejects.toThrow(
      "provider unavailable",
    );
    provider.failByokCheckout = false;
    // Opening the second session expired the first, so no session holds the owner's trial.
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)).toBeUndefined();
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("keeps the trial used when a reopen fails after the earlier trial checkout was paid", async () => {
    const owner = await ownerWith("paidreopen");
    const provider = new BillingEmulator({ modelCredits: true, namespace: `hold-paid-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.selectFunding(owner.first.actor, "byok");
    const first = await customerOf(owner.first.organizationId);
    // The owner pays the trial checkout; its webhook has not been processed yet.
    provider.completeByokCheckout(first);
    const reopening = createBillingService({
      prisma,
      provider: failingByokCheckout(provider),
      webOrigin: "https://example.test",
    });
    // The reopen gives its new hold back when its own checkout call fails.
    await expect(reopening.selectFunding(owner.first.actor, "byok")).rejects.toThrow(
      "provider unavailable",
    );
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("leaves a newer checkout's hold alone when an older one lost its lease while syncing", async () => {
    const owner = await ownerWith("syncleaselost");
    const provider = new GatedSyncEmulator(`hold-syncleaselost-${stamp}`);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.selectFunding(owner.first.actor, "byok");
    const syncing = provider.arm();
    const older = service.selectFunding(owner.first.actor, "byok");
    await syncing;
    // The older request's provider reads outlast its lease, and a newer request takes it over.
    await prisma.billingAccount.updateMany({
      where: { organizationId: owner.first.organizationId },
      data: { checkoutLeaseExpiresAt: new Date(0) },
    });
    await service.selectFunding(owner.first.actor, "byok");
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    // The older request resumes; its own checkout call then fails, as an aborted one does.
    provider.failByokCheckout = true;
    provider.release();
    await expect(older).rejects.toThrow();
    provider.failByokCheckout = false;
    // The newer session is still payable, so it keeps holding the owner's trial.
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("leaves a newer checkout's hold alone when an older one lost its lease while writing", async () => {
    const owner = await ownerWith("writeleaselost");
    const provider = new BillingEmulator({ modelCredits: true, namespace: `hold-write-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    // The older request runs on an API instance with a one-connection pool, and its own
    // checkout call fails, as an aborted one does.
    const stalled = createDb(process.env.DATABASE_URL!, { poolMax: 1, applicationName: "stalled" });
    // Its own name, so the wait below counts only this write and no other test's.
    const expiry = createDb(process.env.DATABASE_URL!, { poolMax: 1, applicationName: "expiry" });
    const olderService = createBillingService({
      prisma: asSystem(stalled.prisma),
      provider: failingByokCheckout(provider),
      webOrigin: "https://example.test",
    });
    let expiryWrite: Promise<unknown> | undefined;
    const blocker = await db.pool.connect();
    try {
      await service.selectFunding(owner.first.actor, "byok");
      // Another write holds the owner's row, so the older request's hold write waits on it.
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [owner.userId]);
      const older = olderService.selectFunding(owner.first.actor, "byok").catch((error) => error);
      await expect
        .poll(
          async () =>
            (
              await db.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = 'stalled' AND wait_event_type = 'Lock' AND query LIKE 'UPDATE%user%'",
              )
            ).rowCount,
          { interval: 10, timeout: 5_000 },
        )
        .toBe(1);
      // The lease lapses during the wait: the expiry write queues on the lease row the older
      // request's transaction holds while its hold write waits, so the lapse is already
      // bound to land mid-write. Wait until the write reached that queue instead of pacing
      // it with a fixed delay a loaded runner can invalidate. The newer request needs no
      // such wait: while the lease reads valid, its claim is refused and retried, not
      // queued behind the holder.
      const expiryWriteQueued = () =>
        db.pool
          .query(
            `SELECT 1 FROM pg_stat_activity
              WHERE application_name = 'expiry' AND wait_event_type = 'Lock'
                AND query LIKE 'UPDATE%billing_accounts%'`,
          )
          .then((result) => result.rowCount);
      expiryWrite = asSystem(expiry.prisma)
        .billingAccount.updateMany({
          where: { organizationId: owner.first.organizationId },
          data: { checkoutLeaseExpiresAt: new Date(0) },
        })
        // A failure here shows as a wrong lease below; teardown waits for it either way.
        .catch(() => undefined);
      const newer = service.selectFunding(owner.first.actor, "byok");
      // Unrelated work queued on the older instance's pool delays its next statement.
      const queued = stalled.pool.query("SELECT pg_sleep(2)");
      await expect.poll(expiryWriteQueued, { interval: 10, timeout: 5_000 }).toBe(1);
      await blocker.query("COMMIT");
      await newer;
      const first = await customerOf(owner.first.organizationId);
      expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
      await queued;
      await expect(older).resolves.toBeInstanceOf(Error);
      // The newer session is still payable, so it keeps holding the owner's trial.
      await service.selectFunding(owner.second.actor, "byok");
      const second = await customerOf(owner.second.organizationId);
      expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await stalled.prisma.$disconnect();
      await stalled.pool.end();
      await expiryWrite;
      await expiry.prisma.$disconnect();
      await expiry.pool.end();
    }
  }, 20_000);

  it("lets go of the lease row when its hold write waits on a locked owner row", async () => {
    const owner = await ownerWith("ownerlocked");
    const provider = new BillingEmulator({ modelCredits: true, namespace: `hold-locked-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    const waiting = createDb(process.env.DATABASE_URL!, { applicationName: "owner-locked" });
    const waitingService = createBillingService({
      prisma: asSystem(waiting.prisma),
      provider,
      webOrigin: "https://example.test",
    });
    const blocker = await db.pool.connect();
    try {
      await service.selectFunding(owner.first.actor, "byok");
      await blocker.query("BEGIN");
      await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [owner.userId]);
      const reopen = waitingService
        .selectFunding(owner.first.actor, "byok")
        .catch((error) => error);
      await expect
        .poll(
          async () =>
            (
              await db.pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE application_name = 'owner-locked' AND wait_event_type = 'Lock' AND query LIKE 'UPDATE%user%'",
              )
            ).rowCount,
          { interval: 10, timeout: 5_000 },
        )
        .toBe(1);
      // While the owner row stays locked, the lease row must come free within the bound, so
      // renewals and other organizations' work do not queue behind it.
      const leaseRowFree = async () =>
        db.pool
          .query('SELECT 1 FROM billing_accounts WHERE "organizationId" = $1 FOR UPDATE NOWAIT', [
            owner.first.organizationId,
          ])
          .then(
            () => true,
            () => false,
          );
      await expect.poll(leaseRowFree, { interval: 50, timeout: 4_000 }).toBe(true);
      await blocker.query("COMMIT");
      const error = await reopen;
      expect(error).toMatchObject({
        code: "CONFLICT",
        message: "Billing is busy; try again shortly",
      });
      // The reopen wrote nothing, so the first session keeps holding the owner's trial.
      await service.selectFunding(owner.second.actor, "byok");
      const second = await customerOf(owner.second.organizationId);
      expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
      await waiting.prisma.$disconnect();
      await waiting.pool.end();
    }
  }, 20_000);

  it("keeps an earlier open session's hold when expiring it fails", async () => {
    const owner = await ownerWith("expirefail");
    const provider = new BillingEmulator({ modelCredits: true, namespace: `hold-expire-${stamp}` });
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.selectFunding(owner.first.actor, "byok");
    const expire = vi
      .spyOn(provider, "expireOpenCheckouts")
      .mockRejectedValue(new Error("provider unavailable"));
    await expect(service.selectFunding(owner.first.actor, "byok")).rejects.toThrow(
      "provider unavailable",
    );
    expire.mockRestore();
    // The first session is still payable, so it keeps holding the owner's trial.
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("holds the trial from the created session's moment, not the reservation's", async () => {
    const owner = await ownerWith("delayed");
    const provider = new DelayedByokEmulator(`hold-delayed-${stamp}`);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    const pending = service.selectFunding(owner.first.actor, "byok");
    await provider.byokCallStarted;
    const beforeCreation = (
      await prisma.user.findUniqueOrThrow({
        where: { id: owner.userId },
        select: { byokTrialCheckoutExpiresAt: true },
      })
    ).byokTrialCheckoutExpiresAt!;
    // The session is created only after this delay; it stays payable a day from then.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    provider.releaseByok();
    await pending;
    const hold = (
      await prisma.user.findUniqueOrThrow({
        where: { id: owner.userId },
        select: { byokTrialCheckoutExpiresAt: true },
      })
    ).byokTrialCheckoutExpiresAt!;
    expect(hold.getTime() - beforeCreation.getTime()).toBeGreaterThan(1000);
  });

  it("keeps the hold while the deletion's billing cancellation keeps failing", async () => {
    const owner = await ownerWith("cancelfail");
    const provider = new FlakyCancelEmulator(`hold-cancelfail-${stamp}`);
    const service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    await service.selectFunding(owner.first.actor, "byok");
    const deps = {
      prisma,
      sandbox: { destroy: vi.fn() },
      home: {},
      jobs: { cancel: vi.fn() } as unknown as JobPublisher,
      artifacts: { remove: vi.fn() } as unknown as ArtifactStore,
      dataDir: root,
      billing: service,
    } as unknown as SpaceDeletionDeps & { billing: ReturnType<typeof createBillingService> };
    provider.failCancellation = true;
    await expect(
      deleteOrganization(deps, owner.userId, owner.first.organizationId),
    ).rejects.toThrow("provider unavailable");
    // The failed deletion left the organization and its payable session, so the trial stays held.
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
    provider.failCancellation = false;
    await deleteOrganization(deps, owner.userId, owner.first.organizationId);
    // The successful cancellation expired that session, so its hold went with it.
    await service.selectFunding(owner.second.actor, "byok");
    expect(provider.byokCheckouts.get(second)?.trialDays).toBe(TRIAL_DAYS);
  });

  it("keeps the hold when moving it to the session's creation fails", async () => {
    const owner = await ownerWith("extendfail");
    const provider = new BillingEmulator({ modelCredits: true, namespace: `hold-extend-${stamp}` });
    const service = createBillingService({
      prisma: extendFailingPrisma(prisma),
      provider,
      webOrigin: "https://example.test",
    });
    await expect(service.selectFunding(owner.first.actor, "byok")).rejects.toThrow(
      "db unavailable",
    );
    // The session was created and stays payable, so the owner's trial remains held.
    const first = await customerOf(owner.first.organizationId);
    expect(provider.byokCheckouts.get(first)?.trialDays).toBe(TRIAL_DAYS);
    await service.selectFunding(owner.second.actor, "byok");
    const second = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second)?.trialDays).toBeUndefined();
  });

  it("serializes overlapping checkout attempts of one organization under its lease", async () => {
    const owner = await ownerWith("overlap");
    const provider = new GatedFailingByokEmulator(`hold-overlap-${stamp}`);
    const watched = watchCheckoutLeaseClaims(prisma);
    const service = createBillingService({
      prisma: watched.prisma,
      provider,
      webOrigin: "https://example.test",
    });
    const first = service.selectFunding(owner.first.actor, "byok");
    await provider.byokCallStarted; // The first attempt holds the lease, at the provider.
    const second = service.selectFunding(owner.first.actor, "byok");
    // Both attempts fail at the provider; before the fix the second reserved its hold while
    // the first was still creating its session, and their rollbacks resurrected it.
    await watched.leaseRefused; // The second attempt is queued behind the first.
    provider.failAndUngate();
    await expect(first).rejects.toThrow("provider unavailable");
    await expect(second).rejects.toThrow("provider unavailable");
    provider.fail = false;
    // Neither attempt left a session, so nothing may hold the owner's trial.
    await service.selectFunding(owner.second.actor, "byok");
    const second2 = await customerOf(owner.second.organizationId);
    expect(provider.byokCheckouts.get(second2)?.trialDays).toBe(TRIAL_DAYS);
  });
});
