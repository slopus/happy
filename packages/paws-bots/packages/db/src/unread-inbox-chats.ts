import { GROUP_MEMBER_MIN } from "@rakazo/contracts";
import { GUEST_ROLE } from "./billing.js";
import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { homeOrganizationId } from "./spaces.js";

/**
 * Counts the chats unread for this person that the inbox lists: every chat in each Space the
 * sidebar shows around this one, those of the user's own organization and those shared with
 * them as a guest.
 */
export function countUnreadInboxChats(
  prisma: PrismaClient,
  { userId, spaceId }: { userId: string; spaceId: string },
): Promise<number> {
  // Cross-Space RLS bypass is restricted to this user's memberships.
  return runAsSystem("count unread inbox chats across the member's Spaces", async () => {
    const organizationId = await homeOrganizationId(prisma, { userId, spaceId });
    const [result] = await prisma.$queryRaw<Array<{ count: number }>>`
      WITH member_spaces AS (
        SELECT m."spaceId" FROM space_members m
        JOIN member o ON o."organizationId" = m."organizationId" AND o."userId" = m."userId"
        WHERE m."userId" = ${userId}
          AND (m."organizationId" = ${organizationId} OR o.role = ${GUEST_ROLE})
      )
      SELECT count(*)::int AS count FROM threads t
      JOIN member_spaces m ON m."spaceId" = t."spaceId"
      JOIN thread_reads r ON r."threadId" = t.id AND r."userId" = ${userId}
      WHERE r.unread
        -- A snoozed chat leaves the inbox until it wakes, so it doesn't count either.
        AND (r."snoozedUntil" IS NULL OR r."snoozedUntil" <= now())
        AND t."externalConversationId" IS NULL
        AND (
          EXISTS (SELECT 1 FROM bots b WHERE b.id = t."botId"
            AND b."spaceId" = t."spaceId" AND b."archivedAt" IS NULL)
          OR EXISTS (SELECT 1 FROM chat_groups g WHERE g.id = t."groupId"
            AND g."spaceId" = t."spaceId" AND g."archivedAt" IS NULL
            AND (SELECT count(*) FROM chat_group_members gm JOIN bots b ON b.id = gm."botId"
              WHERE gm."groupId" = g.id AND b."archivedAt" IS NULL) >= ${GROUP_MEMBER_MIN})
        )`;
    return result?.count ?? 0;
  });
}
