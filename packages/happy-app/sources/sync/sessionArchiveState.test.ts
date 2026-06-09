import { describe, expect, it } from "vitest";
import { isArchivedSession } from "./sessionArchiveState";

describe("isArchivedSession", () => {
    it("uses archivedAt as the archive bucket signal instead of process liveness", () => {
        expect(isArchivedSession({ active: false, archivedAt: null })).toBe(false);
        expect(isArchivedSession({ active: false, archivedAt: undefined })).toBe(false);
        expect(isArchivedSession({ active: true, archivedAt: 1710000000000 })).toBe(true);
    });

    it("falls back to legacy lifecycle metadata when archivedAt has not been backfilled", () => {
        expect(isArchivedSession({
            active: false,
            archivedAt: null,
            metadata: { lifecycleState: "archived" },
        })).toBe(true);
        expect(isArchivedSession({
            active: false,
            archivedAt: undefined,
            lifecycleState: "archiveRequested",
        })).toBe(true);
        expect(isArchivedSession({
            active: false,
            archivedAt: null,
            metadata: { lifecycleState: "running" },
        })).toBe(false);
    });
});
