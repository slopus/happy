import { BillingEmulator } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccessGrant, revokeAccessGrant } from "./access-grants.js";
import { createBillingService } from "./billing.js";

const DAY_MS = 86_400_000;

const dbTests = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
dbTests("access grants", () => {
  const stamp = `${process.pid}-${Date.now()}`;
  const provider = new BillingEmulator({ modelCredits: true, namespace: `grants-${stamp}` });
  const organizations: string[] = [];
  const users: string[] = [];
  let prisma: PrismaClient;
  let db: ReturnType<typeof createDb>;
  let service: ReturnType<typeof createBillingService>;
  let admin: Actor;

  async function signUp(name: string, emailVerified = true): Promise<Actor> {
    const id = `grant-${name}-${stamp}`;
    const createdAt = new Date();
    const email = `${id}@rakazo.test`;
    await prisma.user.create({ data: { id, name, email, emailVerified } });
    await prisma.organization.create({ data: { id, name, slug: id, createdAt } });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Personal", isDefault: true },
    });
    await prisma.member.create({
      data: { id, organizationId: id, userId: id, role: "owner", createdAt },
    });
    organizations.push(id);
    users.push(id);
    return { userId: id, spaceId: id, email, isDeploymentOwner: false };
  }

  const emailFor = (name: string) => `grant-${name}-${stamp}@rakazo.test`;
  const grant = (email: string, input: { creditCents?: number; freeMonths?: number }) =>
    createAccessGrant(prisma, admin.userId, { email: email.toUpperCase(), ...input });

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    service = createBillingService({ prisma, provider, webOrigin: "https://example.test" });
    admin = await signUp("admin");
  });

  afterAll(async () => {
    await prisma.accessGrant.deleteMany({ where: { email: { endsWith: `${stamp}@rakazo.test` } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("gives credits made out before signup once, to the owner's organization", async () => {
    const created = await grant(emailFor("later"), { creditCents: 5000 });
    expect(created).toMatchObject({
      email: emailFor("later"),
      createdBy: admin.email,
      status: "pending",
    });
    const actor = await signUp("later");
    await expect(service.status(actor)).resolves.toMatchObject({
      access: true,
      funding: "credits",
      balanceUsd: 50,
    });
    await expect(service.status(actor)).resolves.toMatchObject({ balanceUsd: 50 });
    const row = await prisma.accessGrant.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ organizationId: actor.spaceId, appliedAt: expect.any(Date) });
  });

  it("gives a free own-key period to an existing account", async () => {
    const actor = await signUp("existing");
    await service.status(actor);
    await grant(actor.email, { freeMonths: 2 });
    const status = await service.status(actor);
    expect(status).toMatchObject({ access: true, funding: "byok" });
    expect(new Date(status.byokFreeUntil!).getTime()).toBeGreaterThan(Date.now() + 59 * DAY_MS);
  });

  it("waits for the email to be verified", async () => {
    const actor = await signUp("unverified", false);
    await grant(actor.email, { creditCents: 1000 });
    await expect(service.status(actor)).resolves.toMatchObject({ access: false, balanceUsd: 0 });
    await prisma.user.update({ where: { id: actor.userId }, data: { emailVerified: true } });
    await expect(service.status(actor)).resolves.toMatchObject({ access: true, balanceUsd: 10 });
  });

  it("revokes only grants nobody has received", async () => {
    const revoked = await grant(emailFor("revoked"), { creditCents: 1000 });
    await expect(revokeAccessGrant(prisma, revoked.id)).resolves.toMatchObject({
      status: "revoked",
    });
    const actor = await signUp("revoked");
    await expect(service.status(actor)).resolves.toMatchObject({ balanceUsd: 0 });

    const applied = await grant(actor.email, { creditCents: 1000 });
    await service.status(actor);
    await expect(revokeAccessGrant(prisma, applied.id)).rejects.toThrow("Already applied");
  });

  it("finishes a grant interrupted after it was claimed", async () => {
    const actor = await signUp("interrupted");
    const created = await grant(actor.email, { creditCents: 2500, freeMonths: 1 });
    await prisma.accessGrant.update({
      where: { id: created.id },
      data: { organizationId: actor.spaceId },
    });
    await expect(service.status(actor)).resolves.toMatchObject({ balanceUsd: 25 });
    await expect(service.status(actor)).resolves.toMatchObject({ balanceUsd: 25 });
  });
});
