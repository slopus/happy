import { randomUUID } from "node:crypto";
import { displayName } from "@rakazo/core";
import { GUEST_ROLE, isOwnerRole, ownedOrganizationId } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { PageShareSecret } from "./page-shares.js";
import { deletePageShareSecrets } from "./page-shares.js";
import { IsolationError } from "./scope.js";
import { releasePendingSpacePayments } from "./spending.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Per member, per organization: one person cannot fan out unbounded boundaries. */
const MAX_SPACES_PER_MEMBER = 32;

export class SpaceLimitError extends Error {
  constructor() {
    super("Space limit reached");
    this.name = "SpaceLimitError";
  }
}

export class InvalidSpaceNameError extends Error {
  constructor() {
    super("Space name must be readable and between 1 and 60 characters");
    this.name = "InvalidSpaceNameError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor() {
    super("Space not found");
    this.name = "SpaceNotFoundError";
  }
}

export class CannotDeleteDefaultSpaceError extends Error {
  constructor() {
    super("The default space cannot be deleted");
    this.name = "CannotDeleteDefaultSpaceError";
  }
}

export class CannotDeleteLastSpaceError extends Error {
  constructor() {
    super("The last remaining space cannot be deleted");
    this.name = "CannotDeleteLastSpaceError";
  }
}

export class CannotDeleteSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can delete it");
    this.name = "CannotDeleteSpaceAsNonOwnerError";
  }
}

export class CannotRenameSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can rename it");
    this.name = "CannotRenameSpaceAsNonOwnerError";
  }
}

export class SpaceDeletionInProgressError extends Error {
  constructor() {
    super("Space deletion is already in progress");
    this.name = "SpaceDeletionInProgressError";
  }
}

export const SPACE_DELETION_CLAIM_TIMEOUT_MS = 5 * 60_000;

type SpaceClient = Pick<
  PrismaClient,
  "space" | "spaceMember" | "memoryDocument" | "notificationPreference" | "bot" | "chatGroup"
>;

interface CreateSpaceInput {
  spaceId: string;
  spaceMembershipId: string;
  organizationId: string;
  userId: string;
  name: string;
  createdAt: Date;
}

async function createSpace(prisma: SpaceClient, input: CreateSpaceInput): Promise<void> {
  await prisma.space.create({
    data: {
      id: input.spaceId,
      organizationId: input.organizationId,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.createdAt,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: input.spaceMembershipId,
      spaceId: input.spaceId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: input.createdAt,
    },
  });
}

async function createSpaceDefaults(
  prisma: SpaceClient,
  input: { spaceId: string; userId: string; memoryContent: string },
): Promise<void> {
  await prisma.memoryDocument.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: "user",
      path: "MEMORY.md",
      content: input.memoryContent,
    },
  });
  await prisma.notificationPreference.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
    },
  });
}

export function normalizeSpaceName(name: string): string {
  const trimmed = name.trim();
  if (!displayName(trimmed, "") || trimmed.length > 60) throw new InvalidSpaceNameError();
  return trimmed;
}

/** Create a sibling privacy boundary in the active organization, or the member's own one from a shared Space. */
export async function createSpaceForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    name: string;
  },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  const spaceId = randomUUID();
  const spaceMembershipId = randomUUID();
  const createdAt = new Date();

  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // From a Space someone shared, a new Space goes in the person's own organization.
        const organizationId = await homeOrganizationId(tx, {
          userId: input.userId,
          spaceId: input.currentSpaceId,
        });
        await lockOrganizationSpaces(tx, organizationId);
        const deleting = await tx.space.count({
          where: {
            organizationId,
            isDefault: true,
            deletingAt: { not: null },
          },
        });
        if (deleting > 0) throw new SpaceDeletionInProgressError();
        const count = await tx.spaceMember.count({
          where: { userId: input.userId, organizationId },
        });
        if (count >= MAX_SPACES_PER_MEMBER) throw new SpaceLimitError();
        await createSpace(tx, {
          spaceId,
          spaceMembershipId,
          organizationId,
          userId: input.userId,
          name,
          createdAt,
        });
        await createSpaceDefaults(tx, {
          spaceId,
          userId: input.userId,
          memoryContent: "# Space memory\n\n",
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  return { id: spaceId, name };
}

/**
 * The organization whose Spaces a person sees around this one: its own, unless they are a guest
 * there, in which case their oldest own organization.
 */
export async function homeOrganizationId(
  db: Pick<PrismaClient, "spaceMember" | "member">,
  actor: { userId: string; spaceId: string },
): Promise<string> {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { organizationId: true, member: { select: { role: true } } },
  });
  if (!membership) throw new IsolationError();
  return membership.member.role === GUEST_ROLE
    ? ownedOrganizationId(db, actor.userId)
    : membership.organizationId;
}

/**
 * The Space a member lands in after leaving or deleting one: their own default
 * Space first, then the oldest they own, then the oldest they belong to.
 */
export async function fallbackSpaceForMember(
  db: Pick<PrismaClient, "spaceMember">,
  userId: string,
  exceptSpaceId?: string,
): Promise<string | null> {
  const memberships = await db.spaceMember.findMany({
    where: {
      userId,
      space: { deletingAt: null },
      ...(exceptSpaceId ? { spaceId: { not: exceptSpaceId } } : {}),
    },
    select: { spaceId: true, role: true, space: { select: { isDefault: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const owned = memberships.filter((membership) => isOwnerRole(membership.role));
  const fallback =
    owned.find((membership) => membership.space.isDefault) ?? owned[0] ?? memberships[0];
  return fallback?.spaceId ?? null;
}

type SpaceMemberTargetInput = {
  currentSpaceId: string;
  userId: string;
  spaceId: string;
};

/** Serialize content creation with the empty-space deletion claim. */
export async function lockSpaceForContentCreation(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text AS "lock"
  `);
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership) throw new IsolationError();
  if (membership.space.deletingAt) throw new SpaceDeletionInProgressError();
  return { organizationId: membership.organizationId };
}

/**
 * Whether a Space takes new work: a run, a retry, maintenance. One being deleted takes none; its
 * work resumes if the deletion is called off. Holds the Space's lock shared until the transaction
 * ends, so a deletion claim, which takes it exclusively, either committed first and is seen here
 * or waits for this work. Call it in a read-committed transaction before locking thread, run or
 * computer rows, which deleting the Space locks after this lock.
 */
export async function spaceTakesWork(
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<boolean> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
  const space = await tx.space.findUnique({ where: { id: spaceId }, select: { deletingAt: true } });
  return !space?.deletingAt;
}

/** Serializes creating a Space in an organization with claiming the organization for deletion. */
export async function lockOrganizationSpaces(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`organization-spaces:${organizationId}`}, 0))::text AS "lock"
  `);
}

export async function lockSpaceDeletion(
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
}

type ClaimedSpaceDeleteInput = SpaceMemberTargetInput & { claimId: string };

async function loadActorSpace(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
) {
  const currentMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.currentSpaceId,
        userId: input.userId,
      },
    },
    select: { organizationId: true },
  });
  if (!currentMembership) throw new IsolationError();
  const targetMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.spaceId,
        userId: input.userId,
      },
    },
    select: {
      organizationId: true,
      role: true,
      space: { select: { isDefault: true, deletingAt: true } },
    },
  });
  if (!targetMembership || targetMembership.organizationId !== currentMembership.organizationId) {
    throw new SpaceNotFoundError();
  }
  return {
    organizationId: currentMembership.organizationId,
    role: targetMembership.role,
    isDefault: targetMembership.space.isDefault,
    deletingAt: targetMembership.space.deletingAt,
  };
}

/** Owner of a non-default Space that is not their last one in the organization. */
async function assertSpaceDeletable(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
): Promise<Array<{ spaceId: string; space: { isDefault: boolean } }>> {
  const owned = await loadActorSpace(db, input);
  if (owned.role !== "owner") throw new CannotDeleteSpaceAsNonOwnerError();
  if (owned.isDefault) throw new CannotDeleteDefaultSpaceError();
  const memberships = await db.spaceMember.findMany({
    where: {
      userId: input.userId,
      organizationId: owned.organizationId,
    },
    select: { spaceId: true, space: { select: { isDefault: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
  return memberships;
}

/**
 * Claim a Space before tearing down its content. Bot and group creation take the same
 * advisory lock and reject a claimed Space, so once claimed it only loses content. A stale
 * claim may be taken over after five minutes; that is safe because destroys are idempotent,
 * every worker verifies its claim token before and after each destroy, provider-handle
 * clearing is conditioned on the claim token, and no worker releases its claim once
 * destructive teardown starts.
 */
export async function claimSpaceDeletionForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput,
): Promise<{ claimId: string; recovered: boolean }> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        await assertSpaceDeletable(tx, input);
        const lifecycle = await tx.space.findUnique({
          where: { id: input.spaceId },
          select: { deletingAt: true },
        });
        const claimedBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        const claimed = await tx.space.updateMany({
          where: {
            id: input.spaceId,
            OR: [{ deletingAt: null }, { deletingAt: { lt: claimedBefore } }],
          },
          data: { deletingAt: new Date(), deletionClaimId: claimId },
        });
        if (claimed.count === 0) throw new SpaceDeletionInProgressError();
        return { claimId, recovered: Boolean(lifecycle?.deletingAt) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Every bot of a claimed Space, archived and other members' included, for per-bot teardown. */
export async function listClaimedSpaceBots(
  prisma: Pick<PrismaClient, "bot">,
  input: ClaimedSpaceDeleteInput,
) {
  return prisma.bot.findMany({
    where: { spaceId: input.spaceId, space: { deletionClaimId: input.claimId } },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Sandboxes still provisioned in a claimed Space once its bots are gone (team computers). */
export async function listClaimedSpaceComputers(
  prisma: Pick<PrismaClient, "computer">,
  input: ClaimedSpaceDeleteInput,
): Promise<Array<{ id: string; homeKey: string; kind: string; providerRef: string }>> {
  const computers = await prisma.computer.findMany({
    where: {
      spaceId: input.spaceId,
      providerRef: { not: null },
      space: { deletionClaimId: input.claimId },
    },
    select: { id: true, homeKey: true, kind: true, providerRef: true },
  });
  return computers.flatMap((computer) =>
    computer.providerRef ? [{ ...computer, providerRef: computer.providerRef }] : [],
  );
}

export async function renewSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<boolean> {
  const renewed = await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: new Date() },
  });
  return renewed.count === 1;
}

/** Release only this caller's deletion claim when nothing has been torn down yet. */
export async function releaseSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<void> {
  await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/**
 * Restores the claim state an account-deletion attempt took over: an earlier attempt's claim,
 * another deletion's stale marker, or none. Every attempt claims under the same token, so only a
 * row still carrying this attempt's id is its own; a later attempt may have taken the rest over.
 */
export async function restoreSpaceDeletionClaims(
  prisma: PrismaClient,
  claim: { claimId: string; attemptId: string },
  takenOver: SpaceDeletionTakeover[],
): Promise<void> {
  for (const space of takenOver)
    await prisma.space.updateMany({
      where: {
        id: space.spaceId,
        deletionClaimId: claim.claimId,
        deletionAttemptId: claim.attemptId,
      },
      data: {
        deletionClaimId: space.deletionClaimId,
        deletingAt: space.deletingAt,
        deletionAttemptId: space.deletionAttemptId,
      },
    });
}

/**
 * Hands an attempt's claims to the next attempt at once, once nothing of it is left running. Like
 * the restore, it leaves claims a later attempt took over.
 */
export async function expireSpaceDeletionClaims(
  prisma: PrismaClient,
  claim: { claimId: string; attemptId: string },
): Promise<void> {
  await prisma.space.updateMany({
    where: { deletionClaimId: claim.claimId, deletionAttemptId: claim.attemptId },
    data: { deletingAt: new Date(0) },
  });
}

/**
 * Delete a claimed, non-default Space and everything left in it. Callers must first
 * destroy every bot and leftover sandbox, clearing its providerRef, so a failed external
 * destroy never loses the only persisted handle; remaining rows go by cascade. Returns the
 * stored artifacts and computer homes to remove after commit, and the space the client
 * should switch to when the active space was deleted.
 */
export async function deleteClaimedSpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{
  id: string;
  artifactKeys: string[];
  homeKeys: string[];
  pageShareSecrets: PageShareSecret[];
}> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const memberships = await assertSpaceDeletable(tx, input);
        const [remainingBots, provisioned, artifacts, computers] = await Promise.all([
          tx.bot.count({ where: { spaceId: input.spaceId } }),
          tx.computer.count({ where: { spaceId: input.spaceId, providerRef: { not: null } } }),
          tx.artifact.findMany({
            where: { spaceId: input.spaceId },
            select: { storageKey: true },
          }),
          tx.computer.findMany({ where: { spaceId: input.spaceId }, select: { homeKey: true } }),
        ]);
        // Content creation is blocked while claimed, so this only trips when teardown
        // was cut short; a retry finishes it.
        if (remainingBots > 0 || provisioned > 0) throw new SpaceDeletionInProgressError();
        const pageShareSecrets = await deletePageShareSecrets(tx, { spaceId: input.spaceId });
        await rehomeMemberItems(tx, input.spaceId);
        await releasePendingSpacePayments(tx, input.spaceId);
        const { organizationId } = await tx.space.delete({
          where: { id: input.spaceId },
          select: { organizationId: true },
        });
        // Guests who only belonged to this Space leave its organization with it.
        await tx.member.deleteMany({
          where: { organizationId, role: GUEST_ROLE, spaceMemberships: { none: {} } },
        });
        const removed = {
          artifactKeys: artifacts.map((artifact) => artifact.storageKey),
          homeKeys: computers.map((computer) => computer.homeKey),
          pageShareSecrets,
        };
        if (input.spaceId !== input.currentSpaceId) {
          return { id: input.currentSpaceId, ...removed };
        }
        const remaining = memberships.filter((membership) => membership.spaceId !== input.spaceId);
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId, ...removed };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/**
 * What the departing person made available in other Spaces of theirs was homed in this one, and
 * would go when it does. Each item moves to a Space it is already available in: one it was chosen
 * for, or for an item available everywhere their fallback Space. A plugin moves with its servers
 * and skills, as one. An item whose new home already has one with the same name stays, and goes
 * with this Space.
 */
export async function rehomeSharedItems(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<void> {
  const { spaceId, userId } = input;
  const fallback = await fallbackSpaceForMember(tx, userId, spaceId);
  const shared = {
    spaceId,
    userId,
    OR: [{ allSpaces: true }, { availableIn: { some: { spaceId: { not: spaceId } } } }],
  };
  const chosen = {
    where: { spaceId: { not: spaceId }, space: { deletingAt: null } },
    select: { spaceId: true },
    orderBy: { spaceId: "asc" as const },
    take: 1,
  };
  const [servers, skills, installs] = await Promise.all([
    tx.mcpServer.findMany({
      where: shared,
      select: { id: true, slug: true, installId: true, allSpaces: true, availableIn: chosen },
    }),
    tx.agentSkill.findMany({
      where: shared,
      select: { id: true, name: true, installId: true, allSpaces: true, availableIn: chosen },
    }),
    tx.capabilityInstall.findMany({
      where: shared,
      select: { id: true, allSpaces: true, availableIn: chosen },
    }),
  ]);
  const homeOf = (item: { allSpaces: boolean; availableIn: Array<{ spaceId: string }> }) =>
    item.allSpaces ? fallback : (item.availableIn[0]?.spaceId ?? null);
  const nameTaken = async (home: string, items: { slugs: string[]; names: string[] }) =>
    (items.slugs.length > 0 &&
      (await tx.mcpServer.count({ where: { spaceId: home, userId, slug: { in: items.slugs } } })) >
        0) ||
    (
      await Promise.all(
        items.names.map((name) =>
          tx.agentSkill.count({
            where: { spaceId: home, userId, name: { equals: name, mode: "insensitive" } },
          }),
        ),
      )
    ).some((count) => count > 0);
  for (const server of servers) {
    const home = homeOf(server);
    if (server.installId || !home) continue;
    if (await nameTaken(home, { slugs: [server.slug], names: [] })) continue;
    await tx.mcpServer.update({ where: { id: server.id }, data: { spaceId: home } });
    await tx.mcpServerSpace.deleteMany({ where: { serverId: server.id, spaceId: home } });
  }
  for (const skill of skills) {
    const home = homeOf(skill);
    if (skill.installId || !home) continue;
    if (await nameTaken(home, { slugs: [], names: [skill.name] })) continue;
    await tx.agentSkill.update({ where: { id: skill.id }, data: { spaceId: home } });
    await tx.agentSkillSpace.deleteMany({ where: { skillId: skill.id, spaceId: home } });
  }
  for (const install of installs) {
    const home = homeOf(install);
    if (!home) continue;
    const parts = await Promise.all([
      tx.mcpServer.findMany({ where: { installId: install.id }, select: { slug: true } }),
      tx.agentSkill.findMany({ where: { installId: install.id }, select: { name: true } }),
    ]);
    const items = {
      slugs: parts[0].map((server) => server.slug),
      names: parts[1].map((skill) => skill.name),
    };
    if (await nameTaken(home, items)) continue;
    const moved = { where: { installId: install.id }, data: { spaceId: home } };
    await tx.capabilityInstall.update({ where: { id: install.id }, data: { spaceId: home } });
    await tx.mcpServer.updateMany(moved);
    await tx.agentSkill.updateMany(moved);
    await tx.capabilityInstallSpace.deleteMany({ where: { installId: install.id, spaceId: home } });
  }
}

/** Before a Space goes, what its members made available elsewhere moves out of it (see above). */
async function rehomeMemberItems(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  const members = await tx.spaceMember.findMany({
    where: { spaceId, role: { not: "owner" } },
    select: { userId: true },
  });
  for (const { userId } of members) await rehomeSharedItems(tx, { spaceId, userId });
}

/**
 * Organizations that go with this account: those where everyone else is a guest, that is, the
 * people it invited into some of its Spaces.
 */
export async function personalOrganizationIds(
  prisma: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string[]> {
  const memberships = await prisma.member.findMany({
    where: { userId, role: { not: GUEST_ROLE } },
    select: {
      organizationId: true,
      organization: { select: { members: { select: { userId: true, role: true } } } },
    },
  });
  return memberships
    .filter(({ organization }) =>
      organization.members.every(
        (member) => member.userId === userId || member.role === GUEST_ROLE,
      ),
    )
    .map(({ organizationId }) => organizationId);
}

/**
 * Claim the spaces that go with this account: every space of its own organizations, shared ones
 * included, and spaces elsewhere where it is the only member. A claimed space refuses new
 * content, so nobody who joins later can lose a bot to the teardown. A retry after a failed
 * deletion takes over every space an earlier attempt claimed, even one someone has since joined,
 * so the last step can release it. A space another deletion is still working on, an earlier
 * attempt of this one included, fails the account deletion until that claim is handed over or
 * goes stale; the claims taken before it are given back. Every attempt writes the same token, so
 * the previous release still finds an attempt's claims during a deploy.
 */
export async function claimSpacesLeavingWithAccount(
  prisma: PrismaClient,
  userId: string,
): Promise<{
  claimId: string;
  attemptId: string;
  spaceIds: string[];
  takenOver: SpaceDeletionTakeover[];
}> {
  const organizationIds = await personalOrganizationIds(prisma, userId);
  const claimId = `account-deletion:${userId}`;
  // Marks every Space this attempt claims, so its rollback and handover touch only those.
  const attemptId = randomUUID();
  const candidates = await prisma.space.findMany({
    where: {
      OR: [
        { organizationId: { in: organizationIds } },
        { memberships: { some: { userId }, every: { userId } } },
        // A Space they own elsewhere: claimed below only when no other full member shares it.
        // One that keeps a full member is handed to them afterwards (leaveInvitedSpaces).
        { memberships: { some: { userId, role: "owner" } } },
        { deletionClaimId: claimId },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const spaceIds: string[] = [];
  const takenOver: SpaceDeletionTakeover[] = [];
  try {
    for (const { id } of candidates) {
      const outcome = await withTransactionRetry(() =>
        prisma.$transaction(
          (tx) => claimSpaceForDeletion(tx, id, claimId, userId, { resume: true, attemptId }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
      if (!outcome.claimed) continue;
      spaceIds.push(id);
      if (outcome.tookOver) takenOver.push({ spaceId: id, ...outcome.tookOver });
    }
  } catch (error) {
    await restoreSpaceDeletionClaims(prisma, { claimId, attemptId }, takenOver);
    throw error;
  }
  return { claimId, attemptId, spaceIds, takenOver };
}

/** What claiming one space did, with what a takeover replaced, so a rollback can restore it. */
export type SpaceDeletionClaimOutcome =
  | { claimed: false }
  | {
      claimed: true;
      /** Null when the claim was already ours; otherwise the state the claim replaced. */
      tookOver: {
        deletionClaimId: string | null;
        deletingAt: Date | null;
        deletionAttemptId: string | null;
      } | null;
    };

/** A space this attempt claimed, with the claim state to restore on rollback. */
export type SpaceDeletionTakeover = {
  spaceId: string;
  deletionClaimId: string | null;
  deletingAt: Date | null;
  deletionAttemptId: string | null;
};

/** Guests joined through an invite and leave with the Space, so they never keep it alive. */
function otherNonGuests(spaceId: string, userId: string): Prisma.SpaceMemberWhereInput {
  return { spaceId, userId: { not: userId }, member: { role: { not: GUEST_ROLE } } };
}

/**
 * Claims a Space for a whole-account or whole-organization deletion, keeping a claim it already
 * holds. Not claimed when the Space is gone or, with `soleMemberId`, someone else belongs to it.
 * With `resume`, the claim token names the deletion, not the attempt: a claim under it is an
 * earlier attempt's, kept even when someone joined since, and taken over only once that attempt
 * handed it over or it went stale. `attemptId` names the attempt on the row; without it the row
 * carries none.
 */
export async function claimSpaceForDeletion(
  tx: Prisma.TransactionClient,
  spaceId: string,
  claimId: string,
  soleMemberId?: string,
  options: { resume?: boolean; attemptId?: string } = {},
): Promise<SpaceDeletionClaimOutcome> {
  await lockSpaceDeletion(tx, spaceId);
  const space = await tx.space.findUnique({
    where: { id: spaceId },
    select: { deletingAt: true, deletionClaimId: true, deletionAttemptId: true },
  });
  if (!space) return { claimed: false };
  const earlier = space.deletionClaimId === claimId;
  if (earlier && !options.resume) return { claimed: true, tookOver: null };
  if (soleMemberId && !earlier) {
    const others = await tx.spaceMember.count({ where: otherNonGuests(spaceId, soleMemberId) });
    if (others > 0) return { claimed: false };
  }
  const stale = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
  if (space.deletionClaimId && space.deletingAt && space.deletingAt >= stale)
    throw new SpaceDeletionInProgressError();
  await tx.space.update({
    where: { id: spaceId },
    data: {
      deletingAt: new Date(),
      deletionClaimId: claimId,
      deletionAttemptId: options.attemptId ?? null,
    },
  });
  return {
    claimed: true,
    tookOver: {
      deletionClaimId: space.deletionClaimId,
      deletingAt: space.deletingAt,
      deletionAttemptId: space.deletionAttemptId,
    },
  };
}

/**
 * Delete a space claimed by `claimSpaceForDeletion`, once its bots and sandboxes are gone. Rows
 * left in it go by cascade, and its keys with it. Returns the stored artifacts to remove after
 * commit, but none when another claim has since taken the space over. With `soleMemberId`, a
 * space someone joined after the claim is released instead and null is returned. With
 * `organizationId`, the organization goes in the same transaction once its last Space does, so it
 * is never left without the claim that lets a retry find it.
 */
export async function deleteClaimedSpace(
  prisma: PrismaClient,
  input: { spaceId: string; claimId: string; soleMemberId?: string; organizationId?: string },
): Promise<{ artifactKeys: string[]; pageShareSecrets: PageShareSecret[] } | null> {
  const { spaceId, claimId, soleMemberId, organizationId } = input;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, spaceId);
        const [others, remainingBots, remainingComputers, artifacts] = await Promise.all([
          soleMemberId ? tx.spaceMember.count({ where: otherNonGuests(spaceId, soleMemberId) }) : 0,
          tx.bot.count({ where: { spaceId } }),
          tx.computer.count({ where: { spaceId } }),
          tx.artifact.findMany({ where: { spaceId }, select: { storageKey: true } }),
        ]);
        if (others > 0) {
          await tx.space.updateMany({
            where: { id: spaceId, deletionClaimId: claimId },
            data: { deletingAt: null, deletionClaimId: null },
          });
          return null;
        }
        // Teardown was cut short; deleting again finishes it.
        if (remainingBots > 0 || remainingComputers > 0) throw new SpaceDeletionInProgressError();
        await rehomeMemberItems(tx, spaceId);
        // The page links' tokens go with the Space; the caller removes them from the store.
        const pageShareSecrets = await tx.secret.findMany({
          where: { pageShare: { is: { spaceId } } },
          select: { id: true, ciphertext: true },
        });
        await releasePendingSpacePayments(tx, spaceId);
        const gone = await tx.space.deleteMany({
          where: { id: spaceId, deletionClaimId: claimId },
        });
        if (organizationId)
          await tx.organization.deleteMany({ where: { id: organizationId, spaces: { none: {} } } });
        // The Space went to another claim: its rows and stored files are not this caller's.
        return {
          artifactKeys: gone.count > 0 ? artifacts.map((artifact) => artifact.storageKey) : [],
          pageShareSecrets: gone.count > 0 ? pageShareSecrets : [],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function renameSpaceForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput & { name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const owned = await loadActorSpace(tx, input);
        if (owned.role !== "owner") throw new CannotRenameSpaceAsNonOwnerError();
        if (owned.deletingAt) throw new SpaceDeletionInProgressError();
        await tx.space.update({
          where: { id: input.spaceId },
          data: { name },
        });
        return { id: input.spaceId, name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
