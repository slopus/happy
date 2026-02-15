import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildUpdateSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";

/**
 * Rename a session by setting its customName field.
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to rename
 * @param customName - New custom name (null to clear)
 * @returns true if rename was successful, false if session not found or not owned by user
 */
export async function sessionRename(ctx: Context, sessionId: string, customName: string | null): Promise<boolean> {
    return await inTx(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid
            }
        });

        if (!session) {
            log({
                module: 'session-rename',
                userId: ctx.uid,
                sessionId
            }, `Session not found or not owned by user`);
            return false;
        }

        // Update customName
        const updatedSession = await tx.session.update({
            where: { id: sessionId },
            data: { customName: customName }
        });

        log({
            module: 'session-rename',
            userId: ctx.uid,
            sessionId,
            customName
        }, `Session renamed successfully`);

        // Send notification after transaction commits
        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildUpdateSessionUpdate(
                sessionId,
                updSeq,
                randomKeyNaked(12),
                { value: updatedSession.metadata, version: updatedSession.metadataVersion }
            );

            log({
                module: 'session-rename',
                userId: ctx.uid,
                sessionId,
                updateType: 'update-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting update-session for rename to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return true;
    });
}
