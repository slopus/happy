import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";
import { deleteSessionAttachments } from "@/storage/files";

/**
 * Delete a session and all its related data.
 * Handles:
 * - Deleting all session messages
 * - Deleting all usage reports for the session
 * - Deleting all access keys for the session
 * - Deleting the session itself
 * - Sending socket notification to all connected clients
 * 
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
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
                module: 'session-delete', 
                userId: ctx.uid, 
                sessionId 
            }, `Session not found or not owned by user`);
            return false;
        }

        // Delete all related data
        // Note: Order matters to avoid foreign key constraint violations
        
        // 1. Delete session messages
        const deletedMessages = await tx.sessionMessage.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedMessages.count
        }, `Deleted ${deletedMessages.count} session messages`);

        // 2. Delete usage reports
        const deletedReports = await tx.usageReport.deleteMany({
            where: { sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId,
            deletedCount: deletedReports.count
        }, `Deleted ${deletedReports.count} usage reports`);

        // 3. Delete access keys
        const deletedAccessKeys = await tx.accessKey.deleteMany({
            where: { sessionId }
        });
        log({
            module: 'session-delete',
            userId: ctx.uid,
            sessionId,
            deletedCount: deletedAccessKeys.count
        }, `Deleted ${deletedAccessKeys.count} access keys`);

        // 4. Delete session events (turn-start/end, mcp__happy__change_title,
        // fork markers, etc — persisted via persistSessionEvent.ts and queried
        // through GET /v3/sessions/:id/events). The original cascade missed
        // this table, so any session that ever emitted an event would fail
        // tx.session.delete with a foreign-key violation and surface as a
        // 500 to clients calling DELETE /v1/sessions/:id.
        const deletedEvents = await tx.sessionEvent.deleteMany({
            where: { sessionId }
        });
        log({
            module: 'session-delete',
            userId: ctx.uid,
            sessionId,
            deletedCount: deletedEvents.count
        }, `Deleted ${deletedEvents.count} session events`);

        // 5. Delete the session itself
        await tx.session.delete({
            where: { id: sessionId }
        });
        log({ 
            module: 'session-delete', 
            userId: ctx.uid, 
            sessionId 
        }, `Session deleted successfully`);

        // Send notification and clean up storage after transaction commits
        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));

            log({
                module: 'session-delete',
                userId: ctx.uid,
                sessionId,
                updateType: 'delete-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting delete-session update to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Delete attachment blobs (local dir or S3 prefix)
            try {
                await deleteSessionAttachments(sessionId);
                log({ module: 'session-delete', userId: ctx.uid, sessionId }, `Attachment blobs deleted`);
            } catch (err) {
                log({ module: 'session-delete', userId: ctx.uid, sessionId, err }, `Failed to delete attachment blobs (non-fatal)`);
            }
        });

        return true;
    });
}