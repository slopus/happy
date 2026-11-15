import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { asSystem, runAsTenant } from "./row-security.js";
import type { PaymentInput } from "./spending.js";
import {
  checkPayment,
  recentPayments,
  recordPayment,
  releasePayment,
  releasePendingSpacePayments,
  saveSpendingLimit,
  spendingStatus,
} from "./spending.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("spending limit (PostgreSQL)", () => {
  const db = databaseUrl ? createDb(databaseUrl, { poolMax: 6 }) : undefined;
  const users: string[] = [];

  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function seedUser(timezone: string | null = null) {
    const prisma = asSystem(db!.prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Spender", email: `${id}@example.test`, emailVerified: true, timezone },
    });
    await prisma.organization.create({
      data: { id, name: "Spender", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Spender", isDefault: true },
    });
    return { userId: id, spaceId: id };
  }

  const payment = (
    actor: { userId: string; spaceId: string },
    amount: number | null,
    extra: Partial<PaymentInput> = {},
  ): PaymentInput => ({
    operationKey: randomUUID(),
    userId: actor.userId,
    spaceId: actor.spaceId,
    botId: "bot",
    threadId: "thread",
    site: "shop.example.test",
    amount,
    currency: amount === null ? null : "usd",
    ...extra,
  });

  it("counts payments up to the limit and refuses the one that goes over", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 10_000, currency: "usd", period: "month" }),
    );

    expect(await as(() => recordPayment(prisma, payment(actor, 6_000)))).toBeNull();
    expect(
      await as(() =>
        checkPayment(prisma, { userId: actor.userId, amount: 4_000, currency: "usd" }),
      ),
    ).toBeNull();
    const over = payment(actor, 4_001);
    expect(await as(() => recordPayment(prisma, over))).toEqual({
      refused: "over_limit",
      limit: { amount: 10_000, currency: "usd", period: "month" },
      spent: 6_000,
    });
    // An unreadable total, or one in another currency, cannot be counted while a limit is set.
    expect(await as(() => recordPayment(prisma, payment(actor, null)))).toMatchObject({
      refused: "unchecked",
    });
    expect(
      await as(() => recordPayment(prisma, payment(actor, 100, { currency: "eur" }))),
    ).toMatchObject({ refused: "unchecked" });
    expect(await as(() => spendingStatus(prisma, actor.userId))).toEqual({
      limit: { amount: 10_000, currency: "usd", period: "month" },
      spent: 6_000,
      shown: true,
    });
  });

  it("counts an operation once and stops counting a released one", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 1_000, currency: "usd", period: "day" }),
    );
    const first = payment(actor, 800);
    expect(await as(() => recordPayment(prisma, first))).toBeNull();
    expect(await as(() => recordPayment(prisma, first))).toBeNull();
    expect((await as(() => spendingStatus(prisma, actor.userId))).spent).toBe(800);
    await as(() => releasePayment(prisma, first.operationKey));
    expect((await as(() => spendingStatus(prisma, actor.userId))).spent).toBe(0);
    expect(await as(() => recordPayment(prisma, payment(actor, 1_000)))).toBeNull();
  });

  it("lets only one of two payments that fit alone but not together through", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 1_000, currency: "usd", period: "none" }),
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(() => recordPayment(prisma, payment(actor, 600)))),
    );
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect((await as(() => spendingStatus(prisma, actor.userId))).spent).toBe(600);
  });

  it("starts a new period in the user's timezone, and keeps spend when the amount changes", async () => {
    const actor = await seedUser("America/New_York");
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 1_000, currency: "usd", period: "day" }),
    );
    // 23:30 on Nov 4 in New York, then 00:30 on Nov 5 there.
    const lateEvening = new Date("2026-11-05T04:30:00Z");
    const afterMidnight = new Date("2026-11-05T05:30:00Z");
    expect(await as(() => recordPayment(prisma, payment(actor, 900), lateEvening))).toBeNull();
    expect(
      await as(() => recordPayment(prisma, payment(actor, 900), new Date("2026-11-05T04:45:00Z"))),
    ).toMatchObject({ refused: "over_limit", spent: 900 });
    expect(await as(() => recordPayment(prisma, payment(actor, 900), afterMidnight))).toBeNull();

    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 2_000, currency: "usd", period: "day" }),
    );
    expect((await as(() => spendingStatus(prisma, actor.userId, afterMidnight))).spent).toBe(900);
    await as(() => saveSpendingLimit(prisma, actor.userId, null));
    expect(await as(() => spendingStatus(prisma, actor.userId))).toMatchObject({
      limit: null,
      spent: 0,
    });
  });

  it("records payments without a limit, so a limit set later counts them", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    expect(await as(() => recordPayment(prisma, payment(actor, 700)))).toBeNull();
    // Nothing to count it by: not recorded, not refused.
    expect(await as(() => recordPayment(prisma, payment(actor, null)))).toBeNull();
    // A bot has paid, so the setting shows even without a card or wallet.
    expect(await as(() => spendingStatus(prisma, actor.userId))).toEqual({
      limit: null,
      spent: 0,
      shown: true,
    });
    await as(() =>
      saveSpendingLimit(prisma, actor.userId, { amount: 1_000, currency: "usd", period: "week" }),
    );
    expect((await as(() => spendingStatus(prisma, actor.userId))).spent).toBe(700);
  });

  it("enforces the strictest reading of a stored limit it can't read", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    await asSystem(prisma).spendingLimit.create({
      data: { userId: actor.userId, amount: 500, currency: "jpy", period: "year" },
    });
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    expect(await as(() => recordPayment(prisma, payment(actor, 600)))).toMatchObject({
      refused: "over_limit",
      limit: { amount: 500, currency: "usd", period: "none" },
    });
    expect(
      await as(() => recordPayment(prisma, payment(actor, 100, { currency: "eur" }))),
    ).toMatchObject({ refused: "unchecked" });
    expect((await as(() => spendingStatus(prisma, actor.userId))).limit).toEqual({
      amount: 500,
      currency: "usd",
      period: "none",
    });
  });

  it("stops counting a deleted Space's wallet purchases still waiting on the owner", async () => {
    const actor = await seedUser();
    const system = asSystem(db!.prisma);
    const purchase = (operationKey: string, status: string) =>
      system.purchase.create({
        data: {
          operationKey,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: "bot",
          threadId: "thread",
          threadGeneration: 0,
          provider: "emulator",
          remoteId: operationKey,
          merchantName: "Shop",
          merchantUrl: "https://shop.example.test",
          amount: 100,
          currency: "usd",
          status,
        },
      });
    const pending = payment(actor, 100);
    const approved = payment(actor, 200);
    await purchase(pending.operationKey, "pending_approval");
    await purchase(approved.operationKey, "approved");
    await runAsTenant(actor, () => recordPayment(db!.prisma, pending));
    await runAsTenant(actor, () => recordPayment(db!.prisma, approved));
    await system.$transaction((tx) => releasePendingSpacePayments(tx, actor.spaceId));
    const rows = await system.payment.findMany({
      where: { userId: actor.userId },
      select: { operationKey: true, releasedAt: true },
    });
    expect(
      rows.find((row) => row.operationKey === pending.operationKey)?.releasedAt,
    ).toBeInstanceOf(Date);
    expect(rows.find((row) => row.operationKey === approved.operationKey)?.releasedAt).toBeNull();
  });

  it("lists the payments that count, newest first, with the names of bots in the user's Spaces", async () => {
    const actor = await seedUser();
    const prisma = db!.prisma;
    const as = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);
    const system = asSystem(prisma);
    // The user belongs to their own Space and to a second one; a third is someone else's.
    const second = randomUUID();
    await system.space.create({
      data: { id: second, organizationId: actor.userId, name: "Second" },
    });
    await system.member.create({
      data: {
        id: randomUUID(),
        organizationId: actor.userId,
        userId: actor.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    // Adding the member may already have joined it to the organization's Spaces.
    await system.spaceMember.createMany({
      data: [actor.spaceId, second].map((spaceId) => ({
        id: randomUUID(),
        spaceId,
        organizationId: actor.userId,
        userId: actor.userId,
        createdAt: new Date(),
      })),
      skipDuplicates: true,
    });
    const stranger = await seedUser();
    const bot = (spaceId: string, userId: string, name: string) =>
      system.bot.create({ data: { spaceId, userId, name, color: "#000000" } });
    const shopper = await bot(actor.spaceId, actor.userId, "Shopper");
    const elsewhere = await bot(second, actor.userId, "Elsewhere");
    const theirs = await bot(stranger.spaceId, stranger.userId, "Theirs");
    const older = payment(actor, 500, { botId: shopper.id });
    const released = payment(actor, 700, { botId: shopper.id });
    const newer = payment(actor, 300, { botId: "gone", site: "other.example.test" });
    await as(() => recordPayment(prisma, older, new Date("2026-11-01T10:00:00Z")));
    await as(() => recordPayment(prisma, released, new Date("2026-11-02T10:00:00Z")));
    await as(() => recordPayment(prisma, newer, new Date("2026-11-03T10:00:00Z")));
    await as(() => releasePayment(prisma, released.operationKey));
    await as(() =>
      recordPayment(
        prisma,
        payment(actor, 200, { botId: elsewhere.id }),
        new Date("2026-10-30T10:00:00Z"),
      ),
    );
    await as(() =>
      recordPayment(
        prisma,
        payment(actor, 100, { botId: theirs.id }),
        new Date("2026-10-29T10:00:00Z"),
      ),
    );
    const listed = await as(() => recentPayments(prisma, actor.userId));
    expect(listed.map(({ id: _id, ...row }) => row)).toEqual([
      {
        site: "other.example.test",
        amount: 300,
        currency: "usd",
        botName: null,
        createdAt: "2026-11-03T10:00:00.000Z",
      },
      {
        site: "shop.example.test",
        amount: 500,
        currency: "usd",
        botName: "Shopper",
        createdAt: "2026-11-01T10:00:00.000Z",
      },
      // A bot in another of the user's Spaces keeps its name; one in a Space the user is not in does not.
      expect.objectContaining({ amount: 200, botName: "Elsewhere" }),
      expect.objectContaining({ amount: 100, botName: null }),
    ]);
    expect(await runAsTenant(stranger, () => recentPayments(prisma, actor.userId))).toEqual([]);
  });

  it("keeps one user's limit and payments from another", async () => {
    const actor = await seedUser();
    const other = await seedUser();
    const prisma = db!.prisma;
    await runAsTenant(actor, () =>
      saveSpendingLimit(prisma, actor.userId, { amount: 500, currency: "gbp", period: "month" }),
    );
    await runAsTenant(actor, () => recordPayment(prisma, payment(actor, 100, { currency: "gbp" })));
    expect(await runAsTenant(other, () => spendingStatus(prisma, actor.userId))).toEqual({
      limit: null,
      spent: 0,
      shown: false,
    });
  });
});
