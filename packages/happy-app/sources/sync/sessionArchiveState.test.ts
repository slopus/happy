import { describe, expect, it } from "vitest";
import { isArchivedSession } from "./sessionArchiveState";

describe("isArchivedSession", () => {
    it("uses archivedAt as the archive bucket signal instead of process liveness", () => {
        expect(isArchivedSession({ active: false, archivedAt: null })).toBe(false);
        expect(isArchivedSession({ active: false, archivedAt: undefined })).toBe(false);
        expect(isArchivedSession({ active: true, archivedAt: 1710000000000 })).toBe(true);
    });
});
