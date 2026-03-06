import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { delay } from "@/utils/delay";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

type ReplayableMessage = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    sentBy: string | null;
    sentByName: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export async function replayFirstMessageToCliWhenConnected(params: {
    ownerId: string;
    sessionId: string;
    message: ReplayableMessage;
    maxWaitMs?: number;
    pollIntervalMs?: number;
}): Promise<boolean> {
    if (params.message.seq !== 1) {
        return false;
    }

    const maxWaitMs = params.maxWaitMs ?? 15000;
    const pollIntervalMs = params.pollIntervalMs ?? 500;
    const attempts = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));

    for (let i = 0; i < attempts; i += 1) {
        const connections = eventRouter.getConnections(params.ownerId);
        if (connections) {
            const targets = [...connections].filter((connection) => (
                connection.connectionType === "session-scoped" && connection.sessionId === params.sessionId
            ));
            if (targets.length > 0) {
                const updateSeq = await allocateUserSeq(params.ownerId);
                const payload = buildNewMessageUpdate(params.message, params.sessionId, updateSeq, randomKeyNaked(12));
                for (const connection of targets) {
                    connection.socket.emit("update", payload);
                }
                return true;
            }
        }
        await delay(pollIntervalMs);
    }

    return false;
}

export function scheduleFirstMessageReplay(params: {
    ownerId: string;
    sessionId: string;
    message: ReplayableMessage;
    maxWaitMs?: number;
    pollIntervalMs?: number;
}): void {
    void replayFirstMessageToCliWhenConnected(params);
}
