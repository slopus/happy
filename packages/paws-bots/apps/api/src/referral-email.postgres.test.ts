import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sendReferralEmails } from "./referral-email.js";

const dbTests =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const DAY = 86_400_000;

dbTests("day-one email eligibility and durable claims", () => {
  const stamp = `email-${Date.now()}`;
  const now = Date.now();
  const ids: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const send = vi.fn(async () => {});
  const onError = vi.fn();
  let reconcile: () => Promise<void>;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    vi.spyOn(Date, "now").mockReturnValue(now);
    reconcile = sendReferralEmails({
      prisma,
      email: { send } as unknown as TransactionalEmailProvider,
      appUrl: "https://app.example.com/app",
      origin: "https://app.example.com",
      secret: "test-auth-secret-at-least-32-characters",
      onError,
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function account(
    label: string,
    age: number,
    options: {
      verified?: boolean;
      optedOut?: boolean;
      role?: string;
      email?: string;
    } = {},
  ) {
    const id = `${stamp}-${label}`;
    ids.push(id);
    await prisma.user.create({
      data: {
        id,
        name: "Alex",
        email: options.email ?? `${id}@example.com`,
        createdAt: new Date(now - age),
        emailVerified: options.verified ?? true,
        marketingEmailOptOutAt: options.optedOut ? new Date(now) : null,
      },
    });
    await prisma.organization.create({
      data: { id, name: "Example", slug: id, createdAt: new Date(now) },
    });
    await prisma.member.create({
      data: {
        id,
        userId: id,
        organizationId: id,
        role: options.role ?? "owner",
        createdAt: new Date(now),
      },
    });
    return id;
  }

  it("waits 24 hours, skips old accounts and honors consent, verification and ownership", async () => {
    const due = await account("due", DAY);
    const combined = await account("combined", DAY, { role: "admin, owner" });
    await account("early", DAY - 1);
    await account("old", 3 * DAY + 1);
    await account("opted-out", DAY, { optedOut: true });
    await account("unverified", DAY, { verified: false });
    await account("member", DAY, { role: "member" });
    await account("not-owner", DAY, { role: "not-owner" });
    await account("bad-address", DAY, { email: "invalid@" });
    const deleted = await account("deleted", DAY);
    await prisma.user.delete({ where: { id: deleted } });
    await reconcile();
    expect(send).toHaveBeenCalledTimes(2);
    const markers = await prisma.emailSend.findMany({ where: { userId: { in: ids } } });
    expect(markers.map((marker) => marker.userId).sort()).toEqual([due, combined].sort());
    expect(onError).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent workers and a subsequent retry in Postgres", async () => {
    await account("concurrent", DAY + 1);
    send.mockClear();
    await Promise.all([reconcile(), reconcile()]);
    await reconcile();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
