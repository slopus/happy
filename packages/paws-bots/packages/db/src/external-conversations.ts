import type { Actor, ExternalConversation, ExternalConversationPolicy } from "@rakazo/contracts";
import { AutomatedSenderPoliciesSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withNewestThreadMessages } from "./preview-messages.js";
import { IsolationError } from "./scope.js";
import { previewFromBlocks } from "./thread-listing.js";
import { readStateFor, unreadFor } from "./thread-reads.js";

interface ExternalBotSenderRow {
  externalConversationId: string;
  senderId: string;
  senderName: string;
}

export function createExternalConversationRepos(prisma: PrismaClient) {
  return {
    async listForSpaces(spaceIds: string[], userId: string): Promise<ExternalConversation[]> {
      if (spaceIds.length === 0) return [];
      const rows = await prisma.externalConversation.findMany({
        where: {
          spaceId: { in: spaceIds },
          bot: { archivedAt: null },
          thread: { isNot: null },
        },
        select: {
          id: true,
          spaceId: true,
          botId: true,
          provider: true,
          displayName: true,
          participantNames: true,
          teamChatAmbientEnabled: true,
          teamChatRules: true,
          automatedSenderPolicies: true,
          updatedAt: true,
          thread: { select: { id: true, reads: readStateFor(userId) } },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      });
      const previewed = await withNewestThreadMessages(prisma, rows, 1);
      const conversationIds = previewed.map((row) => row.id);
      const senderRows =
        conversationIds.length === 0
          ? []
          : await prisma.$queryRaw<ExternalBotSenderRow[]>(Prisma.sql`
              SELECT e."externalConversationId", e."senderId", e."senderName"
              FROM unnest(${conversationIds}::text[]) AS c(id)
              CROSS JOIN LATERAL (
                SELECT "externalConversationId", "senderId", "senderName", "createdAt"
                FROM external_messages
                WHERE "externalConversationId" = c.id AND "senderIsBot"
                ORDER BY "createdAt" DESC
                LIMIT 100
              ) e
              ORDER BY e."externalConversationId", e."createdAt" DESC
            `);
      const messagesByConversation = new Map<
        string,
        Array<{ senderId: string; senderName: string }>
      >();
      for (const row of senderRows) {
        const sender = { senderId: row.senderId, senderName: row.senderName };
        const list = messagesByConversation.get(row.externalConversationId);
        if (list) list.push(sender);
        else messagesByConversation.set(row.externalConversationId, [sender]);
      }
      const conversations = previewed.map((conversation) => ({
        ...conversation,
        messages: messagesByConversation.get(conversation.id) ?? [],
      }));
      return conversations.map((conversation) => {
        if (!conversation.thread) {
          throw new IsolationError("External conversation is missing its thread");
        }
        return {
          id: conversation.id,
          spaceId: conversation.spaceId,
          botId: conversation.botId,
          provider: conversation.provider,
          displayName: conversation.displayName,
          participantNames: conversation.participantNames,
          teamChatAmbientEnabled: conversation.teamChatAmbientEnabled,
          teamChatRules: conversation.teamChatRules,
          automatedSenderPolicies: AutomatedSenderPoliciesSchema.parse(
            conversation.automatedSenderPolicies,
          ),
          automatedSenders: [
            ...new Map(
              conversation.messages.map(({ senderId, senderName }) => [
                senderId,
                { id: senderId, name: senderName },
              ]),
            ).values(),
          ],
          threadId: conversation.thread.id,
          preview: previewFromBlocks(conversation.thread.messages[0]?.blocks),
          unread: unreadFor(conversation.thread),
          updatedAt: conversation.updatedAt.toISOString(),
        };
      });
    },

    async updatePolicy(
      actor: Actor,
      externalConversationId: string,
      policy: ExternalConversationPolicy,
    ): Promise<ExternalConversationPolicy> {
      // Visible to the whole space, but the policy decides when the bot acts with the
      // linking member's chat connection, so only that member changes it.
      const result = await prisma.externalConversation.updateMany({
        where: {
          id: externalConversationId,
          spaceId: actor.spaceId,
          userId: actor.userId,
        },
        data: policy,
      });
      if (result.count !== 1) throw new IsolationError();
      return policy;
    },
  };
}
