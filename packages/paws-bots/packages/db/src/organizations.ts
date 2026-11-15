import { randomUUID } from "node:crypto";
import type { Actor, OrganizationList } from "@rakazo/contracts";
import { GUEST_ROLE, LIVE_ORGANIZATION as LIVE } from "./billing.js";
import { createOrganizationWithDefaultSpace } from "./bootstrap-user.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { IsolationError } from "./scope.js";
import {
  claimSpaceForDeletion,
  homeOrganizationId,
  lockOrganizationSpaces,
  normalizeSpaceName,
  SPACE_DELETION_CLAIM_TIMEOUT_MS,
  SpaceDeletionInProgressError,
} from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const MAX_ORGANIZATIONS_PER_USER = 10;

export class OrganizationLimitError extends Error {
  constructor() {
    super(`You can have up to ${MAX_ORGANIZATIONS_PER_USER} organizations.`);
    this.name = "OrganizationLimitError";
  }
}

export class CannotDeleteLastOrganizationError extends Error {
  constructor() {
    super("Your only organization cannot be deleted");
    this.name = "CannotDeleteLastOrganizationError";
  }
}

export class SharedOrganizationError extends Error {
  constructor() {
    super("An organization with other members cannot be deleted");
    this.name = "SharedOrganizationError";
  }
}

const OWNER = { contains: "owner" };

/** Serializes one user's organization creates and deletes, so the cap and last-org rule hold. */
async function lockUserOrganizations(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`organizations:${userId}`}, 0))::text AS "lock"
  `);
}

export async function createOrganizationForUser(
  prisma: PrismaClient,
  input: { userId: string; name: string },
): Promise<{ id: string; name: string; defaultSpaceId: string }> {
  const name = normalizeSpaceName(input.name);
  const orgId = randomUUID();
  await withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await lockUserOrganizations(tx, input.userId);
      const owned = await tx.member.count({
        where: { userId: input.userId, role: OWNER, organization: LIVE },
      });
      if (owned >= MAX_ORGANIZATIONS_PER_USER) throw new OrganizationLimitError();
      await createOrganizationWithDefaultSpace(tx, {
        userId: input.userId,
        orgId,
        name,
        slug: `org-${randomUUID()}`,
      });
    }),
  );
  return { id: orgId, name, defaultSpaceId: orgId };
}

/**
 * Every organization the user is a member of; only those they own can be managed. One they are
 * only a guest in stays out: its Spaces shared with them show with their own.
 */
export async function listMemberOrganizations(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
): Promise<OrganizationList> {
  const [activeOrganizationId, organizations, memberships] = await Promise.all([
    homeOrganizationId(prisma, actor),
    prisma.organization.findMany({
      where: { members: { some: { userId: actor.userId, role: { not: GUEST_ROLE } } }, ...LIVE },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        spaces: { where: { isDefault: true }, select: { id: true }, take: 1 },
        members: { where: { userId: actor.userId }, select: { role: true }, take: 1 },
        _count: { select: { members: { where: { role: { not: GUEST_ROLE } } } } },
      },
    }),
    prisma.spaceMember.findMany({
      where: { userId: actor.userId, space: { deletingAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { spaceId: true, organizationId: true, member: { select: { role: true } } },
    }),
  ]);
  return {
    activeOrganizationId,
    organizations: organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      defaultSpaceId: organization.spaces[0]!.id,
      // Phase one manages only organizations their owner has to themselves.
      canManage:
        organization._count.members === 1 &&
        organization.members.some((member) => member.role.includes("owner")),
      // Spaces shared with them as a guest show beside the active organization's, as in the
      // sidebar.
      spaceIds: memberships
        .filter((membership) =>
          membership.member.role === GUEST_ROLE
            ? organization.id === activeOrganizationId
            : membership.organizationId === organization.id,
        )
        .map((membership) => membership.spaceId),
    })),
  };
}

export async function renameOrganization(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  const { count } = await prisma.organization.updateMany({
    where: {
      id: input.organizationId,
      members: {
        some: { userId: input.userId, role: OWNER },
        every: { OR: [{ userId: input.userId }, { role: GUEST_ROLE }] },
      },
      ...LIVE,
    },
    data: { name },
  });
  if (count === 0) throw new IsolationError();
  return { id: input.organizationId, name };
}

/**
 * Claims every Space of an organization only its owner belongs to, unless it is the last one they
 * own, which hides it from the list. Each attempt claims under its own token, and the claimed
 * Spaces' `deletingAt` is its lease, which it renews while it runs. A later attempt takes the claim
 * over by replacing the token only once that lease has lapsed, so attempts never overlap and an
 * earlier one can no longer release the claim a later one is tearing down under.
 */
export async function claimOrganizationForDeletion(
  prisma: PrismaClient,
  input: { userId: string; organizationId: string },
): Promise<{ claimId: string; spaceIds: string[]; fresh: boolean }> {
  const claimId = `organization-deletion:${input.organizationId}:${randomUUID()}`;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockUserOrganizations(tx, input.userId);
        const [owner, otherMembers, otherOwned] = await Promise.all([
          tx.member.findFirst({
            where: { organizationId: input.organizationId, userId: input.userId, role: OWNER },
            select: { id: true },
          }),
          // Guests only joined Spaces it shared; they lose those with it.
          tx.member.count({
            where: {
              organizationId: input.organizationId,
              userId: { not: input.userId },
              role: { not: GUEST_ROLE },
            },
          }),
          tx.member.count({
            where: {
              userId: input.userId,
              role: OWNER,
              organizationId: { not: input.organizationId },
              organization: LIVE,
            },
          }),
        ]);
        if (!owner) throw new IsolationError();
        if (otherMembers > 0) throw new SharedOrganizationError();
        if (otherOwned === 0) throw new CannotDeleteLastOrganizationError();
        await lockOrganizationSpaces(tx, input.organizationId);
        // Any earlier claim counts, whichever operation placed it: an attempt that takes over
        // another's claim must never release it.
        const claimed: Prisma.SpaceWhereInput = {
          organizationId: input.organizationId,
          deletionClaimId: { not: null },
        };
        const live = await tx.space.count({
          where: {
            ...claimed,
            deletingAt: { gte: new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS) },
          },
        });
        if (live > 0) throw new SpaceDeletionInProgressError();
        // Take over the lapsed claim, if any, under this attempt's token.
        const taken = await tx.space.updateMany({
          where: claimed,
          data: { deletingAt: new Date(), deletionClaimId: claimId, deletionAttemptId: null },
        });
        const spaces = await tx.space.findMany({
          where: { organizationId: input.organizationId },
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        // Only the attempt that placed the claim may release it; every later attempt takes it
        // over instead.
        const fresh = taken.count === 0;
        for (const { id } of spaces) await claimSpaceForDeletion(tx, id, claimId);
        return { claimId, spaceIds: spaces.map((space) => space.id), fresh };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * Undoes the caller's own claim before anything was torn down, so the organization is listed
 * again. A claim a later attempt took over no longer matches and stays in place.
 */
export async function releaseOrganizationDeletionClaim(
  prisma: PrismaClient,
  input: { organizationId: string; claimId: string },
): Promise<void> {
  await prisma.space.updateMany({
    where: { organizationId: input.organizationId, deletionClaimId: input.claimId },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/**
 * Sets an attempt's lease: now to renew it, or the epoch to hand it to the next attempt at once.
 * False once another attempt took the claim over or the Spaces are gone.
 */
export async function setOrganizationDeletionLease(
  prisma: PrismaClient,
  input: { organizationId: string; claimId: string; at: Date },
): Promise<boolean> {
  const { count } = await prisma.space.updateMany({
    where: { organizationId: input.organizationId, deletionClaimId: input.claimId },
    data: { deletingAt: input.at },
  });
  return count > 0;
}

/** Organizations whose deletion stopped part way and whose lease has lapsed, with their owner. */
export async function listStalledOrganizationDeletions(
  prisma: PrismaClient,
): Promise<{ id: string; ownerId: string }[]> {
  const spaces = await prisma.space.findMany({
    where: {
      deletionClaimId: { startsWith: "organization-deletion:" },
      deletingAt: { lt: new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS) },
      organization: { members: { some: { role: OWNER } } },
    },
    distinct: ["organizationId"],
    select: {
      organizationId: true,
      organization: {
        select: { members: { where: { role: OWNER }, select: { userId: true }, take: 1 } },
      },
    },
  });
  return spaces.map((space) => ({
    id: space.organizationId,
    ownerId: space.organization.members[0]!.userId,
  }));
}

/** Deletes the organization once its Spaces are gone; the rest of its rows go by cascade. */
export async function deleteEmptyOrganization(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const { count } = await prisma.organization.deleteMany({
    where: { id: organizationId, spaces: { none: {} } },
  });
  // A Space created after the claim; deleting again claims and tears it down.
  if (count === 0 && (await prisma.organization.findUnique({ where: { id: organizationId } })))
    throw new SpaceDeletionInProgressError();
}

/** The default Space of the user's oldest organization. */
export async function firstOrganizationSpace(prisma: PrismaClient, userId: string) {
  const space = await prisma.space.findFirst({
    where: {
      isDefault: true,
      deletingAt: null,
      organization: { members: { some: { userId, role: OWNER } } },
    },
    orderBy: [{ organization: { createdAt: "asc" } }, { organizationId: "asc" }],
    select: { id: true },
  });
  if (!space) throw new IsolationError();
  return space.id;
}
