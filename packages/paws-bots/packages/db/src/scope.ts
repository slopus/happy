import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

export class IsolationError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "IsolationError";
  }
}

/** Unique (spaceId, userId, name) collision when renaming a bot section. */
export class BotSectionNameConflictError extends Error {
  constructor(message = "Section name already used") {
    super(message);
    this.name = "BotSectionNameConflictError";
  }
}

/**
 * The actor for a request. Without a chosen Space, a session opens the organization it was
 * first given, which is the one the user was last active in, so its requests never drift
 * between organizations as runs finish elsewhere.
 */
export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  requestedSpaceId?: string | null,
  sessionId?: string,
): Promise<Actor> {
  const organizationId = requestedSpaceId
    ? null
    : await sessionOrganizationId(prisma, userId, sessionId);
  const membership = await prisma.spaceMember.findFirst({
    where: requestedSpaceId
      ? { userId, spaceId: requestedSpaceId }
      : { userId, ...(organizationId ? { organizationId } : {}), space: { deletingAt: null } },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      userId: true,
      spaceId: true,
      member: { select: { user: { select: { email: true } } } },
    },
  });
  if (!membership) {
    throw new IsolationError("No personal space");
  }
  return {
    userId: membership.userId,
    spaceId: membership.spaceId,
    email: membership.member.user.email,
    isDeploymentOwner: false,
  };
}

async function sessionOrganizationId(
  prisma: PrismaClient,
  userId: string,
  sessionId: string | undefined,
): Promise<string | null> {
  return runAsSystem("pick the organization a session opens", async () => {
    const pinned = sessionId ? await sessionPin(prisma, sessionId) : null;
    if (pinned && (await opensInOrganization(prisma, userId, pinned))) return pinned;
    const chosen = await recentOrganizationId(prisma, userId);
    if (!sessionId || !chosen) return chosen;
    // Replace only the pin this request read, so concurrent first requests settle on one.
    const { count } = await prisma.session.updateMany({
      where: { id: sessionId, userId, activeOrganizationId: pinned },
      data: { activeOrganizationId: chosen },
    });
    if (count > 0) return chosen;
    const winner = await sessionPin(prisma, sessionId);
    return winner && (await opensInOrganization(prisma, userId, winner)) ? winner : chosen;
  });
}

async function sessionPin(prisma: PrismaClient, sessionId: string): Promise<string | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { activeOrganizationId: true },
  });
  return session?.activeOrganizationId ?? null;
}

async function opensInOrganization(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await prisma.spaceMember.findFirst({
    where: { userId, organizationId, space: { deletingAt: null } },
    select: { id: true },
  });
  return membership !== null;
}

/** The organization of the user's latest finished run, else of the Space they would open first. */
async function recentOrganizationId(prisma: PrismaClient, userId: string): Promise<string | null> {
  const spaceId = await lastActiveSpaceId(prisma, userId);
  if (spaceId) {
    const space = await prisma.space.findUnique({
      where: { id: spaceId },
      select: { organizationId: true },
    });
    if (space) return space.organizationId;
  }
  const first = await prisma.spaceMember.findFirst({
    where: { userId, space: { deletingAt: null } },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: { organizationId: true },
  });
  return first?.organizationId ?? null;
}

/**
 * The Space of the user's latest finished run, for a client that has not picked one. One
 * index probe per membership, on the partial index that serves recent activity. Ticket work, a
 * background helper and the turn that relays its result finish on their own schedule, so they
 * are not the user's activity.
 */
async function lastActiveSpaceId(prisma: PrismaClient, userId: string): Promise<string | null> {
  const [latest] = await prisma.$queryRaw<Array<{ spaceId: string }>>`
      SELECT member."spaceId"
      FROM "space_members" AS member
      JOIN "spaces" AS space ON space."id" = member."spaceId" AND space."deletingAt" IS NULL
      CROSS JOIN LATERAL (
        SELECT run."completedAt"
        FROM "runs" AS run
        WHERE run."spaceId" = member."spaceId"
          AND run."userId" = member."userId"
          AND run."status" IN ('completed', 'failed', 'cancelled')
          AND run."trigger" NOT IN ('tickets', 'helper', 'helper_result')
          AND run."completedAt" IS NOT NULL
        ORDER BY run."completedAt" DESC
        LIMIT 1
      ) AS latest
      WHERE member."userId" = ${userId}
      ORDER BY latest."completedAt" DESC
      LIMIT 1`;
  return latest?.spaceId ?? null;
}

export function scoped<T extends { spaceId: string; userId?: string }>(
  actor: Actor,
  record: T | null,
): T {
  if (!record || record.spaceId !== actor.spaceId) {
    throw new IsolationError();
  }
  if (record.userId && record.userId !== actor.userId) {
    throw new IsolationError();
  }
  return record;
}
