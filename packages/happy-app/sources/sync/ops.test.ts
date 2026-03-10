import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKill } from "./ops";

const {
    sessionRPCMock,
    requestMock
} = vi.hoisted(() => ({
    sessionRPCMock: vi.fn(),
    requestMock: vi.fn()
}));

vi.mock("./apiSocket", () => ({
    apiSocket: {
        sessionRPC: sessionRPCMock,
        request: requestMock
    }
}));

vi.mock("./sync", () => ({
    sync: {}
}));

describe("sessionKill", () => {
    beforeEach(() => {
        sessionRPCMock.mockReset();
        requestMock.mockReset();
    });

    it("returns the RPC response when the session is reachable", async () => {
        sessionRPCMock.mockResolvedValue({
            success: true,
            message: "Killing happy-cli process"
        });

        const result = await sessionKill("session-1");

        expect(result).toEqual({
            success: true,
            message: "Killing happy-cli process"
        });
        expect(requestMock).not.toHaveBeenCalled();
    });

    it("falls back to the server archive endpoint when the session RPC is unavailable", async () => {
        sessionRPCMock.mockRejectedValue(new Error("RPC method not available"));
        requestMock.mockResolvedValue({
            ok: true
        });

        const result = await sessionKill("session-1");

        expect(result).toEqual({
            success: true,
            message: "Session archived"
        });
        expect(requestMock).toHaveBeenCalledWith("/v1/sessions/session-1/archive", {
            method: "POST"
        });
    });

    it("returns the original error when the failure is not a stale-session case", async () => {
        sessionRPCMock.mockRejectedValue(new Error("RPC call timed out"));

        const result = await sessionKill("session-1");

        expect(result).toEqual({
            success: false,
            message: "RPC call timed out"
        });
        expect(requestMock).not.toHaveBeenCalled();
    });
});
