import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    emitMock,
    allocateUserSeqMock,
    delayMock,
    state,
    resetState
} = vi.hoisted(() => {
    const state = {
        connected: false,
        pollCount: 0,
    };
    return {
        emitMock: vi.fn(),
        allocateUserSeqMock: vi.fn(async () => 42),
        delayMock: vi.fn(async () => {
            state.pollCount += 1;
            if (state.pollCount === 1) {
                state.connected = true;
            }
        }),
        state,
        resetState: () => {
            state.connected = false;
            state.pollCount = 0;
            emitMock.mockClear();
            allocateUserSeqMock.mockClear();
            delayMock.mockClear();
        },
    };
});

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        getConnections: vi.fn(() => {
            if (!state.connected) {
                return new Set();
            }
            return new Set([
                {
                    connectionType: "session-scoped" as const,
                    userId: "owner-1",
                    sessionId: "session-1",
                    socket: { emit: emitMock },
                },
            ]);
        }),
    },
    buildNewMessageUpdate: vi.fn((message: unknown, sessionId: string, updateSeq: number, updateId: string) => ({
        id: updateId,
        seq: updateSeq,
        body: { t: "new-message", sid: sessionId, message },
        createdAt: 1,
    })),
}));

vi.mock("@/utils/delay", () => ({
    delay: delayMock,
}));

vi.mock("@/storage/seq", () => ({
    allocateUserSeq: allocateUserSeqMock,
}));

vi.mock("@/utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id"),
}));

import { eventRouter } from "@/app/events/eventRouter";
import { replayFirstMessageToCliWhenConnected } from "./firstMessageReplay";

const message = {
    id: "msg-1",
    seq: 1,
    content: { t: "encrypted", c: "enc" },
    localId: "local-1",
    sentBy: "user-1",
    sentByName: "User 1",
    createdAt: new Date(1),
    updatedAt: new Date(1),
};

describe("replayFirstMessageToCliWhenConnected", () => {
    beforeEach(() => {
        resetState();
        vi.mocked(eventRouter.getConnections).mockImplementation(() => {
            if (!state.connected) {
                return new Set();
            }
            return new Set([
                {
                    connectionType: "session-scoped" as const,
                    userId: "owner-1",
                    sessionId: "session-1",
                    socket: { emit: emitMock },
                },
            ]) as any;
        });
    });

    it("replays first message when session-scoped connection appears later", async () => {
        const replayed = await replayFirstMessageToCliWhenConnected({
            sessionId: "session-1",
            ownerId: "owner-1",
            message,
            maxWaitMs: 1000,
            pollIntervalMs: 100,
        });

        expect(replayed).toBe(true);
        expect(allocateUserSeqMock).toHaveBeenCalledWith("owner-1");
        expect(emitMock).toHaveBeenCalledTimes(1);
        expect(emitMock).toHaveBeenCalledWith(
            "update",
            expect.objectContaining({
                seq: 42,
                body: expect.objectContaining({ t: "new-message", sid: "session-1" }),
            }),
        );
    });

    it("does not replay non-first messages", async () => {
        const replayed = await replayFirstMessageToCliWhenConnected({
            sessionId: "session-1",
            ownerId: "owner-1",
            message: { ...message, seq: 2 },
            maxWaitMs: 1000,
            pollIntervalMs: 100,
        });

        expect(replayed).toBe(false);
        expect(allocateUserSeqMock).not.toHaveBeenCalled();
        expect(emitMock).not.toHaveBeenCalled();
    });

    it("does not allocate seq when connections exist but no matching session-scoped target", async () => {
        state.connected = false;
        vi.mocked(eventRouter.getConnections).mockReturnValue(new Set([
            {
                connectionType: "user-scoped" as const,
                userId: "owner-1",
                socket: { emit: emitMock },
            },
        ]) as any);

        const replayed = await replayFirstMessageToCliWhenConnected({
            sessionId: "session-1",
            ownerId: "owner-1",
            message,
            maxWaitMs: 0,
            pollIntervalMs: 100,
        });

        expect(replayed).toBe(false);
        expect(allocateUserSeqMock).not.toHaveBeenCalled();
        expect(emitMock).not.toHaveBeenCalled();
    });
});
