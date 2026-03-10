import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDisconnectedSessionInactive } from "./markDisconnectedSessionInactive";

const {
    getConnectionsMock,
    sessionArchiveMock
} = vi.hoisted(() => ({
    getConnectionsMock: vi.fn(),
    sessionArchiveMock: vi.fn()
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        getConnections: getConnectionsMock
    }
}));

vi.mock("./sessionArchive", () => ({
    sessionArchive: sessionArchiveMock
}));

describe("markDisconnectedSessionInactive", () => {
    beforeEach(() => {
        getConnectionsMock.mockReset();
        sessionArchiveMock.mockReset();
    });

    it("archives the session when no other live session-scoped connection remains", async () => {
        getConnectionsMock.mockReturnValue(new Set([
            { connectionType: "user-scoped", userId: "user-1" }
        ]));
        sessionArchiveMock.mockResolvedValue({ found: true, changed: true });

        const result = await markDisconnectedSessionInactive("user-1", "session-1", 1700000000000);

        expect(result).toBe(true);
        expect(sessionArchiveMock).toHaveBeenCalledWith(expect.objectContaining({ uid: "user-1" }), "session-1", 1700000000000);
    });

    it("does nothing when another live connection for the same session still exists", async () => {
        getConnectionsMock.mockReturnValue(new Set([
            { connectionType: "session-scoped", userId: "user-1", sessionId: "session-1" }
        ]));

        const result = await markDisconnectedSessionInactive("user-1", "session-1", 1700000000000);

        expect(result).toBe(false);
        expect(sessionArchiveMock).not.toHaveBeenCalled();
    });
});
