import { beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@/context";
import { sessionArchive } from "./sessionArchive";

const {
    sessionFindFirstMock,
    sessionUpdateManyMock,
    emitEphemeralMock,
    buildSessionActivityEphemeralMock
} = vi.hoisted(() => ({
    sessionFindFirstMock: vi.fn(),
    sessionUpdateManyMock: vi.fn(),
    emitEphemeralMock: vi.fn(),
    buildSessionActivityEphemeralMock: vi.fn((sessionId: string, active: boolean, activeAt: number, thinking: boolean) => ({
        type: "activity",
        id: sessionId,
        active,
        activeAt,
        thinking
    }))
}));

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            findFirst: sessionFindFirstMock,
            updateMany: sessionUpdateManyMock
        }
    }
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeral: emitEphemeralMock
    },
    buildSessionActivityEphemeral: buildSessionActivityEphemeralMock
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

describe("sessionArchive", () => {
    beforeEach(() => {
        sessionFindFirstMock.mockReset();
        sessionUpdateManyMock.mockReset();
        emitEphemeralMock.mockReset();
        buildSessionActivityEphemeralMock.mockClear();
    });

    it("archives an active session and emits an offline activity update", async () => {
        sessionFindFirstMock.mockResolvedValue({ id: "session-1", active: true });
        sessionUpdateManyMock.mockResolvedValue({ count: 1 });

        const result = await sessionArchive(Context.create("user-1"), "session-1", 1700000000000);

        expect(result).toEqual({ found: true, changed: true });
        expect(sessionUpdateManyMock).toHaveBeenCalledWith({
            where: {
                id: "session-1",
                accountId: "user-1",
                active: true
            },
            data: {
                active: false,
                lastActiveAt: new Date(1700000000000)
            }
        });
        expect(buildSessionActivityEphemeralMock).toHaveBeenCalledWith("session-1", false, 1700000000000, false);
        expect(emitEphemeralMock).toHaveBeenCalledWith({
            userId: "user-1",
            payload: {
                type: "activity",
                id: "session-1",
                active: false,
                activeAt: 1700000000000,
                thinking: false
            },
            recipientFilter: { type: "user-scoped-only" }
        });
    });

    it("returns success without emitting when the session is already inactive", async () => {
        sessionFindFirstMock.mockResolvedValue({ id: "session-1", active: false });

        const result = await sessionArchive(Context.create("user-1"), "session-1", 1700000000000);

        expect(result).toEqual({ found: true, changed: false });
        expect(sessionUpdateManyMock).not.toHaveBeenCalled();
        expect(emitEphemeralMock).not.toHaveBeenCalled();
    });

    it("returns not found for a missing session", async () => {
        sessionFindFirstMock.mockResolvedValue(null);

        const result = await sessionArchive(Context.create("user-1"), "missing-session", 1700000000000);

        expect(result).toEqual({ found: false, changed: false });
        expect(sessionUpdateManyMock).not.toHaveBeenCalled();
        expect(emitEphemeralMock).not.toHaveBeenCalled();
    });
});
