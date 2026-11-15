import { createHash, randomBytes, randomUUID } from "node:crypto";
import { GUEST_ROLE, isOwnerRole } from "./billing.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { computerScopeKey, userControlHeldBy } from "./computers.js";
import { appendEventInTransaction } from "./events.js";
import type { RunTeardownTarget } from "./groups.js";
import { snapshotRunTeardownTargets } from "./groups.js";
import { runAsSystem } from "./row-security.js";
import {
  lockSpaceDeletion,
  personalOrganizationIds,
  rehomeSharedItems,
  SpaceNotFoundError,
} from "./spaces.js";
import { activeRunStatuses } from "./thread-listing.js";
import { createPendingSteeringRun } from "./thread-steering.js";
import { withTransactionRetry } from "./transaction-retry.js";

export const SPACE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Open links per Space, so a lost or leaked batch stays small. */
export const MAX_OPEN_SPACE_INVITES = 20;

export class SpaceInviteLimitError extends Error {
  constructor() {
    super("Too many open invite links; wait for some to be used or expire");
    this.name = "SpaceInviteLimitError";
  }
}

/** Owner-only actions. `code` lets a caller outside the RPC boundary answer FORBIDDEN as-is. */
export class SpaceOwnerRequiredError extends Error {
  readonly code = "FORBIDDEN";
  constructor() {
    super("Only the space owner can do that");
    this.name = "SpaceOwnerRequiredError";
  }
}

/** One answer for unknown, expired, and used links, so none can be told apart. */
export class SpaceInviteNotFoundError extends Error {
  constructor() {
    super("This invite link is invalid or has expired");
    this.name = "SpaceInviteNotFoundError";
  }
}

export class SpaceMemberNotFoundError extends Error {
  constructor() {
    super("Member not found");
    this.name = "SpaceMemberNotFoundError";
  }
}

export class CannotRemoveSpaceOwnerError extends Error {
  constructor() {
    super("The space owner cannot be removed");
    this.name = "CannotRemoveSpaceOwnerError";
  }
}

export class SpaceOwnerCannotLeaveError extends Error {
  constructor() {
    super("The space owner cannot leave; delete the space instead");
    this.name = "SpaceOwnerCannotLeaveError";
  }
}

type SpaceRef = { spaceId: string; userId: string };

/**
 * What a departure stopped. The caller cancels the runs' jobs, tears down their
 * screens, then expires their leases, as after archiving a group.
 */
export type SpaceDeparture = {
  cancelledRunIds: string[];
  /** Runs queued for other members' follow-ups that waited behind a cancelled run. */
  continuationRunIds: string[];
  computers: RunTeardownTarget[];
  /** Screens they held, their leases already ended, for the usual expiry to release. */
  heldControls: Array<{ computerId: string; leaseId: string }>;
  /** Newest run.cancelled seq per thread, for realtime fanout. */
  events: Array<{ threadId: string; seq: number }>;
};

/** Whether other people belong to the Space, so they share its chats, computers and browser. */
export async function spaceIsShared(
  db: Pick<PrismaClient, "spaceMember">,
  spaceId: string,
): Promise<boolean> {
  return (await db.spaceMember.count({ where: { spaceId }, take: 2 })) > 1;
}

export async function requireSpaceOwner(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceRef,
): Promise<void> {
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { role: true },
  });
  if (!membership || !isOwnerRole(membership.role)) throw new SpaceOwnerRequiredError();
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function listSpaceMembers(
  prisma: PrismaClient,
  input: SpaceRef,
): Promise<{
  spaceName: string;
  members: Array<{
    userId: string;
    name: string;
    email: string;
    image: string | null;
    role: "owner" | "member";
  }>;
  canManage: boolean;
  openInvites: number;
}> {
  const rows = await prisma.spaceMember.findMany({
    where: { spaceId: input.spaceId },
    select: {
      userId: true,
      role: true,
      space: { select: { name: true } },
      member: { select: { user: { select: { name: true, email: true, image: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const self = rows.find((row) => row.userId === input.userId);
  if (!self) throw new SpaceNotFoundError();
  const members = rows
    .map((row) => ({
      userId: row.userId,
      name: row.member.user.name,
      email: row.member.user.email,
      image: row.member.user.image,
      role: isOwnerRole(row.role) ? ("owner" as const) : ("member" as const),
    }))
    .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner"));
  const canManage = isOwnerRole(self.role);
  const openInvites = canManage
    ? await prisma.spaceInvite.count({
        where: { spaceId: input.spaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      })
    : 0;
  return { spaceName: self.space.name, members, canManage, openInvites };
}

/** A new single-use link. Only its SHA-256 is stored; the token is returned once. */
export async function createSpaceInvite(
  prisma: PrismaClient,
  input: SpaceRef,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SPACE_INVITE_TTL_MS);
  await prisma.$transaction(async (tx) => {
    // Serializes concurrent links for one Space, so the cap holds, and checks the owner under
    // the same lock a handover takes.
    await lockSpaceDeletion(tx, input.spaceId);
    await requireSpaceOwner(tx, input);
    // A Space being deleted would refuse the link the moment it is opened.
    const space = await tx.space.findUnique({
      where: { id: input.spaceId },
      select: { deletingAt: true },
    });
    if (!space || space.deletingAt) throw new SpaceNotFoundError();
    const open = await tx.spaceInvite.count({
      where: { spaceId: input.spaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    if (open >= MAX_OPEN_SPACE_INVITES) throw new SpaceInviteLimitError();
    await tx.spaceInvite.create({
      data: {
        spaceId: input.spaceId,
        tokenHash: hashInviteToken(token),
        createdByUserId: input.userId,
        expiresAt,
      },
    });
  });
  return { token, expiresAt };
}

/** Every link not yet used stops working. */
export async function cancelSpaceInvites(prisma: PrismaClient, input: SpaceRef): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSpaceDeletion(tx, input.spaceId);
    await requireSpaceOwner(tx, input);
    await tx.spaceInvite.deleteMany({ where: { spaceId: input.spaceId, acceptedAt: null } });
  });
}

type InviteRow = {
  id: string;
  spaceId: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  createdBy: { name: string };
  space: { name: string; organizationId: string; isDefault: boolean; deletingAt: Date | null };
};

async function findInvite(
  db: Pick<PrismaClient, "spaceInvite" | "spaceMember">,
  token: string,
  userId: string,
): Promise<{ invite: InviteRow; alreadyMember: boolean }> {
  const invite = await db.spaceInvite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      id: true,
      spaceId: true,
      expiresAt: true,
      acceptedAt: true,
      acceptedByUserId: true,
      createdBy: { select: { name: true } },
      space: {
        select: { name: true, organizationId: true, isDefault: true, deletingAt: true },
      },
    },
  });
  if (!invite || invite.space.deletingAt) throw new SpaceInviteNotFoundError();
  const membership = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: invite.spaceId, userId } },
    select: { id: true },
  });
  const alreadyMember = membership !== null;
  const open = invite.acceptedAt === null && invite.expiresAt > new Date();
  // The person who used a link can reopen it while they still belong to the space.
  const usedBySelf = invite.acceptedByUserId === userId && alreadyMember;
  if (!open && !usedBySelf) throw new SpaceInviteNotFoundError();
  return { invite, alreadyMember };
}

export async function previewSpaceInvite(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceId: string; spaceName: string; inviterName: string; alreadyMember: boolean }> {
  const { invite, alreadyMember } = await findInvite(prisma, input.token, input.userId);
  return {
    spaceId: invite.spaceId,
    spaceName: invite.space.name,
    inviterName: invite.createdBy.name,
    alreadyMember,
  };
}

/**
 * Join the space a link points at. Claiming the link and adding the member
 * commit together, so a link is used at most once. Opening a link to a space
 * the person already belongs to leaves the link unused.
 */
export async function acceptSpaceInvite(
  prisma: PrismaClient,
  input: { token: string; userId: string },
): Promise<{ spaceId: string; organizationId: string; joined: boolean }> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const { invite, alreadyMember } = await findInvite(tx, input.token, input.userId);
        const result = { spaceId: invite.spaceId, organizationId: invite.space.organizationId };
        if (alreadyMember) return { ...result, joined: false };
        await lockSpaceDeletion(tx, invite.spaceId);
        const now = new Date();
        const claimed = await tx.spaceInvite.updateMany({
          where: { id: invite.id, acceptedAt: null, expiresAt: { gt: now } },
          data: { acceptedAt: now, acceptedByUserId: input.userId },
        });
        const space = await tx.space.findUnique({
          where: { id: invite.spaceId },
          select: { deletingAt: true },
        });
        if (claimed.count !== 1 || !space || space.deletingAt) throw new SpaceInviteNotFoundError();

        const organizationId = invite.space.organizationId;
        const existing = await tx.member.findUnique({
          where: { organizationId_userId: { organizationId, userId: input.userId } },
          select: { id: true },
        });
        if (!existing) {
          const memberId = randomUUID();
          await tx.member.create({
            data: {
              id: memberId,
              organizationId,
              userId: input.userId,
              role: GUEST_ROLE,
              createdAt: now,
            },
          });
          // A database trigger adds every new organization member to its default
          // Space. An invite opens one Space only, so undo that for any other.
          if (!invite.space.isDefault) {
            await tx.spaceMember.deleteMany({
              where: { id: `default-space-member:${memberId}`, userId: input.userId },
            });
          }
        }
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: invite.spaceId, userId: input.userId } },
          create: {
            id: randomUUID(),
            spaceId: invite.spaceId,
            organizationId,
            userId: input.userId,
            role: "member",
            createdAt: now,
          },
          // An invite into the default Space finds the trigger's row, which copied the org role.
          update: { role: "member" },
        });
        return { ...result, joined: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Owner only. The removed person's bots, chats and routines stay with the space. */
export async function removeSpaceMember(
  prisma: PrismaClient,
  input: SpaceRef & { memberUserId: string },
): Promise<SpaceDeparture> {
  await requireSpaceOwner(prisma, input);
  const target = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.memberUserId } },
    select: { role: true },
  });
  if (!target) throw new SpaceMemberNotFoundError();
  if (input.memberUserId === input.userId || isOwnerRole(target.role)) {
    throw new CannotRemoveSpaceOwnerError();
  }
  return departSpace(prisma, {
    spaceId: input.spaceId,
    userId: input.memberUserId,
    removedBy: input.userId,
  });
}

/** Members only; an owner deletes the space instead. */
export async function leaveSpace(prisma: PrismaClient, input: SpaceRef): Promise<SpaceDeparture> {
  const membership = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { role: true },
  });
  if (!membership) throw new SpaceNotFoundError();
  if (isOwnerRole(membership.role)) throw new SpaceOwnerCannotLeaveError();
  return departSpace(prisma, { ...input, leaving: true });
}

/** A deactivated account was turned back on while it was leaving its invited Spaces. */
class AccountReactivatedError extends Error {}

/**
 * Before deleting or after deactivating an account: leave every Space it was invited into, so what
 * it made there passes to each Space's owner. Spaces in its own organizations are left alone: they
 * go with a deleted account and stay with a deactivated one. A deleted account also hands the
 * Spaces it owns elsewhere to a teammate; a `deactivated` one keeps them, since it may come back,
 * and stops leaving once it is active again.
 */
export async function leaveInvitedSpaces(
  prisma: PrismaClient,
  userId: string,
  /** Runs after each departure commits, so a later failure loses no earlier follow-up. */
  onDeparture: (departure: SpaceDeparture & { spaceId: string }) => Promise<void>,
  { deactivated = false }: { deactivated?: boolean } = {},
): Promise<Array<SpaceDeparture & { spaceId: string }>> {
  const owned = new Set(await personalOrganizationIds(prisma, userId));
  const memberships = await prisma.spaceMember.findMany({
    where: { userId },
    select: { spaceId: true, role: true, space: { select: { organizationId: true } } },
  });
  const departures: Array<SpaceDeparture & { spaceId: string }> = [];
  for (const membership of memberships) {
    // A Space in an organization that goes with the account goes with it.
    if (owned.has(membership.space.organizationId)) continue;
    const { spaceId } = membership;
    if (deactivated && isOwnerRole(membership.role)) continue;
    // Someone who left or was removed meanwhile has already departed: nothing is left to do. A
    // deactivated account made owner meanwhile keeps the Space. A deleted owner that cannot hand
    // it over stays, so its things there go with the account.
    const departure = await departSpace(prisma, {
      spaceId,
      userId,
      ...(deactivated ? { leaving: true, deactivated } : { handOver: true }),
    }).catch((error: unknown) => {
      if (error instanceof SpaceMemberNotFoundError) return null;
      if (error instanceof SpaceOwnerCannotLeaveError) return null;
      if (error instanceof AccountReactivatedError) return "reactivated" as const;
      throw error;
    });
    if (departure === "reactivated") break;
    if (!departure) continue;
    departures.push({ spaceId, ...departure });
    await onDeparture({ spaceId, ...departure });
  }
  return departures;
}

/**
 * Makes the longest-standing full member the departing owner's Space's owner, so the account can
 * leave it like anyone else, and returns who. Null when another owner already keeps it, or when
 * only guests are left and the Space goes with the account (claimSpacesLeavingWithAccount): either
 * way the account's own things in it go with the account.
 */
async function handOwnership(
  tx: Prisma.TransactionClient,
  input: SpaceRef,
): Promise<string | null> {
  const { spaceId, userId } = input;
  const coOwner = await tx.spaceMember.findFirst({
    where: { spaceId, userId: { not: userId }, role: { contains: "owner" } },
    select: { id: true },
  });
  if (coOwner) return null;
  const successor = await tx.spaceMember.findFirst({
    where: { spaceId, userId: { not: userId }, member: { role: { not: GUEST_ROLE } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, userId: true },
  });
  if (!successor) return null;
  await tx.spaceMember.update({ where: { id: successor.id }, data: { role: "owner" } });
  return successor.userId;
}

/**
 * Take one person out of a Space. What they made there for everyone (bots,
 * chats, routines, sections) passes to the Space's owner, so nothing keeps
 * running with the credentials of someone who left. What was theirs alone
 * (credentials, connections, MCP servers, approval rules, preferences) is
 * deleted. Their organization membership goes too once no Space there is left.
 * Their unfinished runs there are cancelled: those run with their accounts.
 */
async function departSpace(
  prisma: PrismaClient,
  input: SpaceRef & {
    removedBy?: string;
    leaving?: boolean;
    deactivated?: boolean;
    /** A departing owner first hands the Space over, in the same transaction, so a failed
     * departure never leaves it handed over without having left. */
    handOver?: boolean;
  },
): Promise<SpaceDeparture> {
  const { spaceId, userId, removedBy, leaving, deactivated, handOver } = input;
  // Bots, routines and credentials are tenant rows; this moves them between people.
  return runAsSystem("move a departing member's Space content to its owner", () =>
    withTransactionRetry(() =>
      prisma.$transaction(
        async (tx) => {
          await lockSpaceDeletion(tx, spaceId);
          if (deactivated) {
            // Held until commit, so a reactivation lands either before this (and it stays) or
            // after it (and the departure stands).
            const [account] = await tx.$queryRaw<Array<{ deactivatedAt: Date | null }>>`
              SELECT "deactivatedAt" FROM "user" WHERE id = ${userId} FOR SHARE
            `;
            if (!account?.deactivatedAt) throw new AccountReactivatedError();
          }
          const departing = await tx.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId, userId } },
            select: { id: true, organizationId: true, role: true },
          });
          if (!departing) throw new SpaceMemberNotFoundError();
          const others = await tx.spaceMember.findMany({
            where: { spaceId, userId: { not: userId } },
            select: { userId: true, role: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          // A removal checks the remover again under the lock: ownership may have moved since.
          if (removedBy !== undefined) {
            const remover = others.find((member) => member.userId === removedBy);
            if (!remover || !isOwnerRole(remover.role)) throw new SpaceOwnerRequiredError();
            if (isOwnerRole(departing.role)) throw new CannotRemoveSpaceOwnerError();
          }
          // Someone made owner since they asked to leave stays: the Space is theirs now.
          if (leaving && isOwnerRole(departing.role)) throw new SpaceOwnerCannotLeaveError();
          let ownerId = others.find((member) => isOwnerRole(member.role))?.userId;
          if (handOver && isOwnerRole(departing.role)) {
            ownerId = (await handOwnership(tx, { spaceId, userId })) ?? undefined;
            if (!ownerId) throw new SpaceOwnerCannotLeaveError();
          }
          if (!ownerId) throw new CannotRemoveSpaceOwnerError();

          const runs = await tx.run.findMany({
            where: { spaceId, userId, status: { in: activeRunStatuses } },
            select: {
              id: true,
              taskId: true,
              threadId: true,
              botId: true,
              userId: true,
              spaceId: true,
            },
          });
          const cancelledRunIds = runs.map((run) => run.id);
          // Snapshot before cancelling: an expired lease still names the run's screen.
          const { targets } = await snapshotRunTeardownTargets(tx, cancelledRunIds);
          const cancelled = await cancelRunsInTransaction(tx, runs, new Date());
          const latestSeq = new Map<string, number>();
          if (cancelled.length) {
            await tx.event.deleteMany({
              where: { type: "thread.progress", runId: { in: cancelledRunIds } },
            });
            for (const run of cancelled) {
              const event = await appendEventInTransaction(tx, {
                spaceId,
                threadId: run.threadId,
                botId: run.botId,
                runId: run.id,
                type: "run.cancelled",
                payload: {},
              });
              latestSeq.set(run.threadId, event.seq);
            }
          }
          // Queued follow-ups would otherwise start a run as them.
          await tx.steeringMessage.deleteMany({ where: { userId, bot: { spaceId } } });
          // Others' follow-ups that waited behind a cancelled run start now, as they would
          // once it finished.
          const continuationRunIds: string[] = [];
          const waiting = new Map(
            cancelled.map(({ threadId, botId }) => [`${threadId}:${botId}`, { threadId, botId }]),
          );
          for (const thread of waiting.values()) {
            const id = await createPendingSteeringRun(tx, { spaceId, ...thread });
            if (id) continuationRunIds.push(id);
          }

          await moveSections(tx, { spaceId, fromUserId: userId, toUserId: ownerId });
          const reassign = { where: { spaceId, userId }, data: { userId: ownerId } };
          await tx.bot.updateMany(reassign);
          await tx.thread.updateMany(reassign);
          await tx.chatGroup.updateMany(reassign);
          // A screen they hold is no one's to release now: end the lease so others can take it.
          // Found before their computers change hands, so a lease from before holders were
          // recorded (held by whoever the computer is kept for) is theirs, not the owner's.
          const held = await tx.computer.findMany({
            where: {
              spaceId,
              controlHolder: "user",
              ...userControlHeldBy(userId),
            },
            select: { id: true, controlLeaseId: true },
          });
          if (held.length) {
            await tx.computer.updateMany({
              where: { id: { in: held.map((computer) => computer.id) } },
              data: { controlLeaseExpiresAt: new Date(), controlUserId: userId },
            });
          }
          // Their computers go with the bots, so the computer limit counts them for the owner.
          await tx.computer.updateMany(reassign);
          // A team computer is found by its person. A departing owner's is the Space's one Team
          // Computer, so it is found by the next owner's key from now on; any other is retired
          // so someone who rejoins starts fresh. The home key, and with it the files, stays.
          // Dedicated computers are found by their bot, so their key stays as it is.
          const teamComputer = await tx.computer.findUnique({
            where: { scopeKey: computerScopeKey({ mode: "team", spaceId, userId }) },
            select: { id: true },
          });
          if (teamComputer) {
            const ownerKey = computerScopeKey({ mode: "team", spaceId, userId: ownerId });
            const keepsSpaceComputer =
              isOwnerRole(departing.role) &&
              !(await tx.computer.findUnique({
                where: { scopeKey: ownerKey },
                select: { id: true },
              }));
            await tx.computer.update({
              where: { id: teamComputer.id },
              data: { scopeKey: keepsSpaceComputer ? ownerKey : `transferred:${teamComputer.id}` },
            });
          }
          // Paused: the owner's accounts must not start running someone else's prompt unasked.
          await tx.routine.updateMany({
            where: { spaceId, userId },
            // A watch restarts from the owner's accounts, not the departed person's results.
            // Backoff earned on their accounts does not hold the owner back either.
            data: {
              userId: ownerId,
              active: false,
              nextRunAt: null,
              watchState: Prisma.DbNull,
              accountFailures: 0,
            },
          });

          const own = { spaceId, userId };
          await tx.botSecret.deleteMany({ where: own });
          // Their vault for this Space only; the account vault every Space uses stays theirs.
          await tx.vaultCredential.deleteMany({ where: own });
          await tx.botMcpServer.deleteMany({
            where: { spaceId, OR: [{ userId }, { server: { userId } }] },
          });
          // What they made available in other Spaces of theirs keeps working there; the rest
          // of their tools here, plugins with all their parts, goes.
          await rehomeSharedItems(tx, { spaceId, userId });
          await tx.capabilityInstall.deleteMany({ where: own });
          await tx.mcpServer.deleteMany({ where: own });
          await tx.agentSkill.deleteMany({ where: own });
          await tx.mcpServerSpace.deleteMany({ where: own });
          await tx.capabilityInstallSpace.deleteMany({ where: own });
          await tx.agentSkillSpace.deleteMany({ where: own });
          // The bots they chose here for their account vault's items. An item they limited here
          // stays limited, so rejoining never opens it to every bot.
          await tx.vaultCredentialBot.deleteMany({ where: own });
          await tx.mcpOAuthSession.deleteMany({ where: own });
          await tx.modelOAuthSession.deleteMany({ where: own });
          await tx.connection.deleteMany({ where: own });
          await tx.messagingIdentity.deleteMany({ where: own });
          await tx.messagingLinkCode.deleteMany({ where: own });
          await tx.messagingInstallation.deleteMany({ where: own });
          await tx.messagingInstallSession.deleteMany({ where: own });
          await tx.actionApprovalRule.deleteMany({ where: { spaceId, createdByUserId: userId } });
          await tx.actionAutoReviewPreference.deleteMany({ where: own });
          await tx.notificationPreference.deleteMany({ where: own });
          await tx.secret.deleteMany({ where: own });
          // Model, voice and role preferences, setting overrides, AI consents and their read state
          // in each chat cascade from here.
          await tx.spaceMember.delete({ where: { id: departing.id } });
          // A guest belonged only through its Spaces; a full member keeps their organization.
          await tx.member.deleteMany({
            where: {
              organizationId: departing.organizationId,
              userId,
              role: GUEST_ROLE,
              spaceMemberships: { none: {} },
            },
          });
          return {
            cancelledRunIds,
            continuationRunIds,
            computers: targets,
            heldControls: held.flatMap((computer) =>
              computer.controlLeaseId
                ? [{ computerId: computer.id, leaseId: computer.controlLeaseId }]
                : [],
            ),
            events: [...latestSeq].map(([threadId, seq]) => ({ threadId, seq })),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ),
  );
}

/** Sections are unique per (space, person, name): merge into the owner's same-named one. */
async function moveSections(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; fromUserId: string; toUserId: string },
): Promise<void> {
  const [moving, kept] = await Promise.all([
    tx.botSection.findMany({
      where: { spaceId: input.spaceId, userId: input.fromUserId },
      select: { id: true, name: true },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    }),
    tx.botSection.findMany({
      where: { spaceId: input.spaceId, userId: input.toUserId },
      select: { id: true, name: true, position: true },
    }),
  ]);
  const keptByName = new Map(kept.map((section) => [section.name, section.id]));
  let position = Math.max(-1, ...kept.map((section) => section.position));
  for (const section of moving) {
    const target = keptByName.get(section.name);
    if (target) {
      await tx.bot.updateMany({ where: { sectionId: section.id }, data: { sectionId: target } });
      await tx.chatGroup.updateMany({
        where: { sectionId: section.id },
        data: { sectionId: target },
      });
      await tx.botSection.delete({ where: { id: section.id } });
    } else {
      position += 1;
      await tx.botSection.update({
        where: { id: section.id },
        data: { userId: input.toUserId, position },
      });
    }
  }
}
