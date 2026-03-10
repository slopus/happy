import { eventRouter } from "@/app/events/eventRouter";
import { Context } from "@/context";
import { sessionArchive } from "./sessionArchive";

export async function markDisconnectedSessionInactive(
    userId: string,
    sessionId: string,
    activeAt: number = Date.now()
): Promise<boolean> {
    const remainingConnections = eventRouter.getConnections(userId);
    const hasOtherLiveSessionConnection = Array.from(remainingConnections ?? []).some((connection) => (
        connection.connectionType === "session-scoped" &&
        connection.sessionId === sessionId
    ));

    if (hasOtherLiveSessionConnection) {
        return false;
    }

    const result = await sessionArchive(Context.create(userId), sessionId, activeAt);
    return result.changed;
}
