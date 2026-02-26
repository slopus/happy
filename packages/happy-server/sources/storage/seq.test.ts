import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSessionUpdate = vi.fn();

vi.mock("@/storage/db", () => ({
    db: {
        session: {
            update: (...args: unknown[]) => mockSessionUpdate(...args),
        },
    },
}));

import { allocateSessionSeqBatch } from "@/storage/seq";

describe("allocateSessionSeqBatch", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should return N consecutive sequence numbers when allocating a batch", async () => {
        mockSessionUpdate.mockResolvedValue({ seq: 15 });

        const result = await allocateSessionSeqBatch("session-1", 5);

        expect(result).toEqual([11, 12, 13, 14, 15]);
        expect(mockSessionUpdate).toHaveBeenCalledWith({
            where: { id: "session-1" },
            select: { seq: true },
            data: { seq: { increment: 5 } },
        });
    });

    it("should return single element array when count is 1", async () => {
        mockSessionUpdate.mockResolvedValue({ seq: 7 });

        const result = await allocateSessionSeqBatch("session-1", 1);

        expect(result).toEqual([7]);
        expect(mockSessionUpdate).toHaveBeenCalledWith({
            where: { id: "session-1" },
            select: { seq: true },
            data: { seq: { increment: 1 } },
        });
    });

    it("should return empty array when count is 0", async () => {
        const result = await allocateSessionSeqBatch("session-1", 0);

        expect(result).toEqual([]);
        expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it("should return empty array when count is negative", async () => {
        const result = await allocateSessionSeqBatch("session-1", -3);

        expect(result).toEqual([]);
        expect(mockSessionUpdate).not.toHaveBeenCalled();
    });

    it("should use provided transaction client instead of default db", async () => {
        const mockTxUpdate = vi.fn().mockResolvedValue({ seq: 20 });
        const txClient = {
            account: { update: vi.fn() },
            session: { update: mockTxUpdate },
        };

        const result = await allocateSessionSeqBatch("session-1", 3, txClient as any);

        expect(result).toEqual([18, 19, 20]);
        expect(mockTxUpdate).toHaveBeenCalledWith({
            where: { id: "session-1" },
            select: { seq: true },
            data: { seq: { increment: 3 } },
        });
        // Ensure the default db client was NOT used
        expect(mockSessionUpdate).not.toHaveBeenCalled();
    });
});
