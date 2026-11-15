import { ORPCError } from "@orpc/server";
import { displayName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  crossSpaceCommunicationAllowed,
  formatMessagingLinkCode,
  issueMessagingLinkCode,
  isUniqueViolation,
  runAsSystem,
  spaceIsShared,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";

export function messagingRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    messaging: {
      installations: {
        list: authed.messaging.installations.list.handler(async ({ context }) => {
          if (!deps.messagingInstallations)
            return { available: false, installations: [], personalLinkAvailable: false };
          const [installations, personalLinkAvailable] = await Promise.all([
            deps.messagingInstallations.list(context.actor),
            deps.messagingInstallations.canLinkPersonalMessages(context.actor),
          ]);
          return { available: true, installations, personalLinkAvailable };
        }),
        start: authed.messaging.installations.start.handler(async ({ context, input }) => {
          if (!deps.messagingInstallations) throw new ORPCError("BAD_REQUEST");
          return { url: await deps.messagingInstallations.start(context.actor, input.botId) };
        }),
        complete: authed.messaging.installations.complete.handler(async ({ context, input }) => {
          if (!deps.messagingInstallations) throw new ORPCError("BAD_REQUEST");
          try {
            await deps.messagingInstallations.complete(context.actor, input.state, input.code);
          } catch {
            throw new ORPCError("BAD_REQUEST");
          }
          return { ok: true as const };
        }),
        remove: authed.messaging.installations.remove.handler(async ({ context, input }) => {
          if (!deps.messagingInstallations) throw new ORPCError("BAD_REQUEST");
          await deps.messagingInstallations.remove(context.actor, input.id);
          return { ok: true as const };
        }),
      },
      status: authed.messaging.status.handler(async ({ context }) => {
        const identities = await acrossChatIdentities(() =>
          deps.prisma.messagingIdentity.findMany({
            where: { userId: context.actor.userId },
            orderBy: { createdAt: "asc" },
          }),
        );
        return {
          enabled: deps.messaging?.enabled ?? false,
          providers: deps.messaging?.providers ?? [],
          addresses: deps.messaging?.addresses ?? {},
          openSignup: deps.messaging?.openSignup ?? false,
          identities: await Promise.all(
            identities.map((identity) => messagingIdentityDto(deps.prisma, identity)),
          ),
        };
      }),
      link: {
        start: authed.messaging.link.start.handler(async ({ context, input }) => {
          // Any of the user's bots, so a workspace's DMs link from whichever space is open.
          const bot = await runAsSystem("find a bot to link a chat app", () =>
            deps.prisma.bot.findFirst({
              where: {
                id: input.botId,
                userId: context.actor.userId,
                archivedAt: null,
                space: { memberships: { some: { userId: context.actor.userId } } },
              },
              select: { id: true, spaceId: true },
            }),
          );
          if (!bot) throw new ORPCError("NOT_FOUND");
          // One chat identity per bot: delivery mirrors a bot's replies to
          // exactly one conversation.
          // The bot may live in another space, so look across them.
          const linked = await acrossChatIdentities(() =>
            deps.prisma.messagingIdentity.findUnique({
              where: { botId: bot.id },
              select: { id: true },
            }),
          );
          if (linked) {
            throw new ORPCError("BAD_REQUEST", {
              message: "That bot is already linked to a chat app; unlink it first.",
            });
          }
          const issued = await issueMessagingLinkCode(deps.prisma, {
            userId: context.actor.userId,
            spaceId: bot.spaceId,
            botId: bot.id,
          });
          const shared = await spaceIsShared(deps.prisma, bot.spaceId);
          return {
            code: formatMessagingLinkCode(issued.code),
            expiresAt: issued.expiresAt.toISOString(),
            ...(shared ? { shared } : {}),
          };
        }),
      },
      identities: {
        setBot: authed.messaging.identities.setBot.handler(async ({ context, input }) => {
          const identity = await acrossChatIdentities(() =>
            deps.prisma.messagingIdentity.findFirst({
              where: { id: input.identityId, userId: context.actor.userId },
            }),
          );
          if (!identity) throw new ORPCError("NOT_FOUND");
          // A workspace install delivers DMs only into its own space, so moving
          // the link elsewhere would silently drop them.
          if (identity.installationId && identity.spaceId !== context.actor.spaceId) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Pick a bot in the space this Slack workspace is connected to.",
            });
          }
          const bot = await deps.prisma.bot.findFirst({
            where: {
              id: input.botId,
              spaceId: context.actor.spaceId,
              userId: context.actor.userId,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!bot) throw new ORPCError("NOT_FOUND");
          try {
            const updated = await acrossChatIdentities(() =>
              deps.prisma.messagingIdentity.update({
                where: { id: identity.id },
                // The identity must live in the bot's space: runs resolve
                // credentials, memory, and approval rules from run.spaceId.
                data: { botId: bot.id, spaceId: context.actor.spaceId },
              }),
            );
            return messagingIdentityDto(deps.prisma, updated);
          } catch (error) {
            // botId is unique: the target bot is already linked elsewhere.
            if (isUniqueViolation(error)) {
              throw new ORPCError("BAD_REQUEST", {
                message: "That bot is already linked to a chat app.",
              });
            }
            throw error;
          }
        }),
        unlink: authed.messaging.identities.unlink.handler(async ({ context, input }) => {
          const { count } = await acrossChatIdentities(() =>
            deps.prisma.messagingIdentity.deleteMany({
              where: { id: input.identityId, userId: context.actor.userId },
            }),
          );
          if (count === 0) throw new ORPCError("NOT_FOUND");
          return { ok: true as const };
        }),
      },
      channels: {
        list: authed.messaging.channels.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const memberships = await deps.prisma.messagingChannelMember.findMany({
            where: { identityId: { in: identities.map((identity) => identity.id) } },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
            orderBy: { updatedAt: "desc" },
          });
          return memberships.map((membership) => messagingChannelDto(membership));
        }),
        respond: authed.messaging.channels.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
                include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
              })
            : null;
          if (membership?.status !== "invited") {
            throw new ORPCError("NOT_FOUND");
          }
          const { count } = await deps.prisma.messagingChannelMember.updateMany({
            where: { id: membership.id, status: "invited" },
            data: { status: input.accept ? "approved" : "declined" },
          });
          if (count === 0) {
            // Lost a race with leave/sweep: approval must not resurrect a
            // departed member.
            throw new ORPCError("NOT_FOUND");
          }
          const updated = await deps.prisma.messagingChannelMember.findUniqueOrThrow({
            where: { id: membership.id },
            include: { channel: { include: { members: ACTIVE_CHANNEL_MEMBERS } } },
          });
          return messagingChannelDto(updated);
        }),
        leave: authed.messaging.channels.leave.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const membership = identities.length
            ? await deps.prisma.messagingChannelMember.findFirst({
                where: {
                  id: input.membershipId,
                  identityId: { in: identities.map((identity) => identity.id) },
                },
              })
            : null;
          if (!membership) throw new ORPCError("NOT_FOUND");
          await deps.prisma.messagingChannelMember.update({
            where: { id: membership.id },
            data: { status: "left" },
          });
          return { ok: true as const };
        }),
      },
      connections: {
        list: authed.messaging.connections.list.handler(async ({ context }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          if (identities.length === 0) return [];
          const botIds = identities.map((identity) => identity.botId);
          const connections = await deps.prisma.agentConnection.findMany({
            where: {
              OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
            },
            orderBy: { updatedAt: "desc" },
          });
          const myBotIds = new Set(botIds);
          return Promise.all(
            connections.map((connection) =>
              messagingConnectionDto(deps.prisma, myBotIds, connection),
            ),
          );
        }),
        respond: authed.messaging.connections.respond.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const myBotIds = new Set(identities.map((identity) => identity.botId));
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  targetBotId: { in: [...myBotIds] },
                  status: "pending",
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          const { updated, requesterToNotify } = await acrossChatIdentities(() =>
            deps.prisma.$transaction(async (tx) => {
              // The claim holds the connection row lock through commit, so a
              // revoke either beats it or waits — it can never interleave with
              // the confirmation write below.
              if (
                input.accept &&
                !(await crossSpaceCommunicationAllowed(
                  tx,
                  connection.requesterBotId,
                  connection.targetBotId,
                ))
              ) {
                throw new ORPCError("FORBIDDEN");
              }
              const { count } = await tx.agentConnection.updateMany({
                where: { id: connection.id, status: "pending" },
                data: { status: input.accept ? "approved" : "declined" },
              });
              if (count === 0) {
                // Lost a race with revoke: approval must never overwrite it.
                throw new ORPCError("NOT_FOUND");
              }
              const row = await tx.agentConnection.findUniqueOrThrow({
                where: { id: connection.id },
              });
              if (!input.accept) return { updated: row, requesterToNotify: null };
              // Parity with the text-command path: the requester hears about it.
              const requesterIdentity = await tx.messagingIdentity.findUnique({
                where: { botId: connection.requesterBotId },
              });
              if (!requesterIdentity) return { updated: row, requesterToNotify: null };
              const delivery = deps.messagingDelivery;
              if (!delivery) return { updated: row, requesterToNotify: null };
              // A re-approved pair starts a fresh cycle; the stale row would swallow the
              // new confirmation.
              await delivery.recordIn(
                tx,
                { identityId: requesterIdentity.id },
                [
                  {
                    idempotencyKey: `command:connected:${connection.id}`,
                    kind: "dm",
                    identityId: requesterIdentity.id,
                    body: "Your connection request was accepted. Your agents can now message each other.",
                  },
                ],
                { replace: true },
              );
              return { updated: row, requesterToNotify: requesterIdentity.id };
            }),
          );
          if (requesterToNotify)
            await deps.messagingDelivery?.send([{ identityId: requesterToNotify }]);
          return messagingConnectionDto(deps.prisma, myBotIds, updated);
        }),
        revoke: authed.messaging.connections.revoke.handler(async ({ context, input }) => {
          const identities = await messagingIdentitiesFor(deps.prisma, context.actor.userId);
          const botIds = identities.map((identity) => identity.botId);
          const connection = identities.length
            ? await deps.prisma.agentConnection.findFirst({
                where: {
                  id: input.connectionId,
                  OR: [{ requesterBotId: { in: botIds } }, { targetBotId: { in: botIds } }],
                },
              })
            : null;
          if (!connection) throw new ORPCError("NOT_FOUND");
          // Claim + invite cancel in one transaction. The status update holds
          // the connection row lock through commit, so a concurrent reconnect
          // (FOR UPDATE) waits until both the revoke and the invite delete
          // finish — otherwise it could reopen and create a fresh invite that
          // a post-commit deleteMany would then wipe while leaving the row
          // pending with no approval prompt.
          await acrossChatIdentities(() =>
            deps.prisma.$transaction(async (tx) => {
              const { count } = await tx.agentConnection.updateMany({
                where: { id: connection.id, status: connection.status },
                data: { status: "revoked" },
              });
              if (count === 0) throw new ORPCError("NOT_FOUND");
              // Cancel undelivered invites, including one a sender already claimed.
              // Connect-invite delivery holds this connection row FOR UPDATE through
              // the send, so revoke either waits until the DM is sent or deletes the
              // row before the send starts.
              await tx.messagingOutbound.deleteMany({
                where: {
                  idempotencyKey: `connect:${connection.requesterBotId}:${connection.targetBotId}`,
                  OR: [
                    { status: { in: ["pending", "retry"] } },
                    { status: "sent", providerHandle: null },
                  ],
                },
              });
            }),
          );
          return { ok: true as const };
        }),
      },
    },
  };
}

const ACTIVE_CHANNEL_MEMBERS = {
  where: { status: { in: ["invited", "approved"] } },
  select: { id: true },
};

type MessagingIdentityRecord = {
  id: string;
  botId: string;
};

/** Every linked chat app counts: channels and connections span identities. */
async function messagingIdentitiesFor(
  prisma: PrismaClient,
  userId: string,
): Promise<MessagingIdentityRecord[]> {
  return acrossChatIdentities(() =>
    prisma.messagingIdentity.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, botId: true },
    }),
  );
}

/**
 * Chat identities belong to the account, linked to bots in any of its Spaces, and an
 * agent connection joins two accounts' bots. Every query run through this names the
 * actor's own identities or bots, or a peer the actor is connected to.
 */
function acrossChatIdentities<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem("the account's chat identities and agent connections across Spaces", fn);
}

async function messagingIdentityDto(
  prisma: PrismaClient,
  identity: { id: string; provider: string; address: string; botId: string },
) {
  const bot = await acrossChatIdentities(() =>
    prisma.bot.findUnique({
      where: { id: identity.botId },
      select: { name: true },
    }),
  );
  return {
    id: identity.id,
    provider: identity.provider,
    address: identity.address,
    botId: identity.botId,
    botName: bot?.name ?? "",
  };
}

function messagingChannelDto(membership: {
  id: string;
  channelId: string;
  // Never null here: every membership reaching this DTO was matched by one of
  // the caller's identity ids.
  identityId: string | null;
  status: string;
  channel: { provider: string; name: string | null; members: Array<{ id: string }> };
}) {
  return {
    id: membership.id,
    channelId: membership.channelId,
    identityId: membership.identityId!,
    provider: membership.channel.provider,
    name: membership.channel.name,
    status: membership.status as "invited" | "approved" | "declined" | "left",
    memberCount: membership.channel.members.length,
  };
}

async function messagingConnectionDto(
  prisma: PrismaClient,
  myBotIds: ReadonlySet<string>,
  connection: {
    id: string;
    requesterBotId: string;
    targetBotId: string;
    status: string;
  },
) {
  const incoming = myBotIds.has(connection.targetBotId);
  // The target's identity stays opaque until they approve (mirrors connect_agent).
  if (!incoming && connection.status !== "approved") {
    return {
      id: connection.id,
      peerBotName: "agent",
      peerOwnerLabel: "owner",
      status: connection.status as "pending" | "approved" | "declined" | "revoked",
      incoming,
    };
  }
  const peerBotId = incoming ? connection.requesterBotId : connection.targetBotId;
  const [peerBot, peerIdentity] = await acrossChatIdentities(() =>
    Promise.all([
      prisma.bot.findUnique({ where: { id: peerBotId }, select: { name: true } }),
      prisma.messagingIdentity.findUnique({
        where: { botId: peerBotId },
        select: { userId: true },
      }),
    ]),
  );
  const peerOwner = peerIdentity
    ? await prisma.user.findUnique({
        where: { id: peerIdentity.userId },
        select: { name: true },
      })
    : null;
  return {
    id: connection.id,
    peerBotName: peerBot?.name ?? "",
    peerOwnerLabel: displayName(peerOwner?.name, "").split(/\s+/)[0] ?? "",
    status: connection.status as "pending" | "approved" | "declined" | "revoked",
    incoming,
  };
}
