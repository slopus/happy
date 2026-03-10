import { buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";
import { Context } from "@/context";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

export interface SessionArchiveResult {
    found: boolean;
    changed: boolean;
}

export async function sessionArchive(
    ctx: Context,
    sessionId: string,
    activeAt: number = Date.now()
): Promise<SessionArchiveResult> {
    const session = await db.session.findFirst({
        where: {
            id: sessionId,
            accountId: ctx.uid
        },
        select: {
            id: true,
            active: true
        }
    });

    if (!session) {
        log({
            module: "session-archive",
            userId: ctx.uid,
            sessionId
        }, "Session not found or not owned by user");
        return { found: false, changed: false };
    }

    if (!session.active) {
        return { found: true, changed: false };
    }

    const clampedActiveAt = Math.min(activeAt, Date.now());
    const updated = await db.session.updateMany({
        where: {
            id: sessionId,
            accountId: ctx.uid,
            active: true
        },
        data: {
            active: false,
            lastActiveAt: new Date(clampedActiveAt)
        }
    });

    if (updated.count === 0) {
        return { found: true, changed: false };
    }

    eventRouter.emitEphemeral({
        userId: ctx.uid,
        payload: buildSessionActivityEphemeral(sessionId, false, clampedActiveAt, false),
        recipientFilter: { type: "user-scoped-only" }
    });

    return { found: true, changed: true };
}
