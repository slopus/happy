import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
    const dbMock = {
        account: { count: vi.fn() },
        session: { count: vi.fn() },
        sessionMessage: { count: vi.fn() },
        machine: { count: vi.fn() },
        $queryRaw: vi.fn()
    };

    return { dbMock };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

import { updateDatabaseMetrics } from "./metrics2";

describe("updateDatabaseMetrics", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.account.count.mockResolvedValue(10);
        dbMock.session.count.mockResolvedValue(20);
        dbMock.sessionMessage.count.mockResolvedValue(30);
        dbMock.machine.count.mockResolvedValue(40);
        dbMock.$queryRaw.mockResolvedValue([{ estimated_count: 123n }]);
    });

    it("uses estimated counts instead of exact table counts", async () => {
        await updateDatabaseMetrics();

        expect(dbMock.account.count).not.toHaveBeenCalled();
        expect(dbMock.session.count).not.toHaveBeenCalled();
        expect(dbMock.sessionMessage.count).not.toHaveBeenCalled();
        expect(dbMock.machine.count).not.toHaveBeenCalled();
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(4);

        const queriedTables = dbMock.$queryRaw.mock.calls.map((call) => call[1]);
        expect(queriedTables).toEqual(['"Account"', '"Session"', '"SessionMessage"', '"Machine"']);
    });
});
