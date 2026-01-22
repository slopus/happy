import { db } from "@/storage/db";
import { Context } from "@/context";
import { log } from "@/utils/log";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

/**
 * Disconnects a GitHub account from a user profile.
 * 
 * Flow:
 * 1. Check if user has GitHub connected - early exit if not
 * 2. In transaction: clear GitHub link and username from account (keeps avatar) and delete GitHub user record
 * 3. Send socket update after transaction completes
 * 
 * @param ctx - Request context containing user ID
 */
export async function githubDisconnect(ctx: Context): Promise<void> {
    const userId = ctx.uid;

    // Step 1: Check if user has GitHub connection
    const user = await db.account.findUnique({
        where: { id: userId },
        select: { githubUserId: true }
    });

    // Early exit if no GitHub connection
    if (!user?.githubUserId) {
        log({ module: 'github-disconnect' }, `User ${userId} has no GitHub account connected`);
        return;
    }

    const githubUserId = user.githubUserId;
    log({ module: 'github-disconnect' }, `Disconnecting GitHub account ${githubUserId} from user ${userId}`);

    // Step 2: Transaction for atomic database operations
    await db.$transaction(async (tx) => {
        // Clear GitHub connection and username from account (keep avatar)
        await tx.account.update({
            where: { id: userId },
            data: {
                githubUserId: null,
                username: null
            }
        });

        // Delete GitHub user record (includes token)
        await tx.githubUser.delete({
            where: { id: githubUserId }
        });
    });

    // Step 3: Send update via socket (after transaction completes)
    const updSeq = await allocateUserSeq(userId);
    const updatePayload = buildUpdateAccountUpdate(userId, {
        github: null,
        username: null
    }, updSeq, randomKeyNaked(12));

    eventRouter.emitUpdate({
        userId,
        payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' }
    });

    log({ module: 'github-disconnect' }, `GitHub account ${githubUserId} disconnected successfully from user ${userId}`);
}