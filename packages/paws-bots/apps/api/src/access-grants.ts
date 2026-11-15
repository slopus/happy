import { ORPCError } from "@orpc/server";
import type { AccessGrant, AccessGrantInput } from "@rakazo/contracts";
import { AccessGrantInputSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { extendByokFreePeriod, FREE_MONTH_DAYS, reconcileCreditPurchase } from "@rakazo/db";

const LIST_LIMIT = 200;
const WITH_CREATOR = { createdBy: { select: { email: true } } } as const;

function accessGrantDto(
  row: Prisma.AccessGrantGetPayload<{ include: typeof WITH_CREATOR }>,
): AccessGrant {
  return {
    id: row.id,
    email: row.email,
    creditCents: row.creditCents,
    freeMonths: row.freeMonths,
    createdBy: row.createdBy?.email ?? null,
    status: row.revokedAt ? "revoked" : row.appliedAt ? "applied" : "pending",
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  };
}

export async function listAccessGrants(prisma: PrismaClient): Promise<AccessGrant[]> {
  const rows = await prisma.accessGrant.findMany({
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    include: WITH_CREATOR,
  });
  return rows.map(accessGrantDto);
}

export async function createAccessGrant(
  prisma: PrismaClient,
  createdById: string,
  input: AccessGrantInput,
): Promise<AccessGrant> {
  const data = AccessGrantInputSchema.parse(input);
  return accessGrantDto(
    await prisma.accessGrant.create({ data: { ...data, createdById }, include: WITH_CREATOR }),
  );
}

export async function revokeAccessGrant(prisma: PrismaClient, id: string): Promise<AccessGrant> {
  const revoked = await prisma.accessGrant.updateMany({
    where: { id, organizationId: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  const row = await prisma.accessGrant.findUnique({ where: { id }, include: WITH_CREATOR });
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Grant not found" });
  if (revoked.count === 0 && !row.revokedAt)
    throw new ORPCError("CONFLICT", { message: "Already applied" });
  return accessGrantDto(row);
}

export async function applyAccessGrants(
  prisma: PrismaClient,
  input: { userId: string; email: string; organizationId: string },
): Promise<void> {
  const { organizationId } = input;
  const pending = {
    appliedAt: null,
    revokedAt: null,
    OR: [{ organizationId: null }, { organizationId }],
  };
  const grants = await prisma.accessGrant.findMany({
    where: { email: input.email.toLowerCase(), ...pending },
  });
  if (grants.length === 0) return;
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { emailVerified: true },
  });
  // Otherwise anyone could sign up as the address and take its grants.
  if (!user?.emailVerified) return;
  for (const grant of grants) {
    const claimed = await prisma.accessGrant.updateMany({
      where: { id: grant.id, ...pending },
      data: { organizationId },
    });
    if (claimed.count === 0) continue;
    if (grant.creditCents > 0)
      await reconcileCreditPurchase(prisma, organizationId, {
        id: `grant_${grant.id}`,
        amountCents: grant.creditCents,
      });
    await prisma.$transaction(async (tx) => {
      const applied = await tx.accessGrant.updateMany({
        where: { id: grant.id, appliedAt: null },
        data: { appliedAt: new Date() },
      });
      if (applied.count === 0) return;
      await tx.modelCreditAccount.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      });
      if (grant.freeMonths > 0)
        await extendByokFreePeriod(tx, organizationId, grant.freeMonths * FREE_MONTH_DAYS);
      await tx.modelCreditAccount.updateMany({
        where: { organizationId, mode: null },
        data: { mode: grant.creditCents > 0 ? "credits" : "byok" },
      });
    });
  }
}
