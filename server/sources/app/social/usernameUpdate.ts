import { db } from "@/storage/db";
import { Context } from "@/context";
import { allocateUserSeq } from "@/storage/seq";
import { buildUpdateAccountUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

export async function usernameUpdate(ctx: Context, username: string): Promise<void> {
    const userId = ctx.uid;

    // Check if username is already taken
    const existingUser = await db.account.findFirst({
        where: {
            username: username,
            NOT: { id: userId }
        }
    });
    if (existingUser) { // Should never happen
        throw new Error('Username is already taken');
    }

    // Update username
    await db.account.update({
        where: { id: userId },
        data: { username: username }
    });

    // Send account update to all user connections
    const updSeq = await allocateUserSeq(userId);
    const updatePayload = buildUpdateAccountUpdate(userId, { username: username }, updSeq, randomKeyNaked(12));
    eventRouter.emitUpdate({
        userId, payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' }
    });
}