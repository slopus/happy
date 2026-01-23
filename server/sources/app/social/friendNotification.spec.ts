import { describe, it, expect, vi } from "vitest";
import { RelationshipStatus } from "@/storage/prisma";

// Mock the dependencies that require environment variables
vi.mock("@/storage/files", () => ({
    getPublicUrl: vi.fn((path: string) => `https://example.com/${path}`)
}));

vi.mock("@/app/feed/feedPost", () => ({
    feedPost: vi.fn()
}));

vi.mock("@/storage/inTx", () => ({
    afterTx: vi.fn()
}));

// Import after mocking
import { shouldSendNotification } from "./friendNotification";

describe("friendNotification", () => {
    describe("shouldSendNotification", () => {
        it("should return true when lastNotifiedAt is null", () => {
            const result = shouldSendNotification(null, RelationshipStatus.pending);
            expect(result).toBe(true);
        });

        it("should return false for rejected relationships", () => {
            const result = shouldSendNotification(null, RelationshipStatus.rejected);
            expect(result).toBe(false);
        });

        it("should return false for rejected relationships even if 24 hours passed", () => {
            const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
            const result = shouldSendNotification(twentyFiveHoursAgo, RelationshipStatus.rejected);
            expect(result).toBe(false);
        });

        it("should return true when 24 hours have passed since last notification", () => {
            const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
            const result = shouldSendNotification(twentyFiveHoursAgo, RelationshipStatus.pending);
            expect(result).toBe(true);
        });

        it("should return false when less than 24 hours have passed", () => {
            const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
            const result = shouldSendNotification(tenHoursAgo, RelationshipStatus.pending);
            expect(result).toBe(false);
        });

        it("should work for friend status", () => {
            const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
            const result = shouldSendNotification(twentyFiveHoursAgo, RelationshipStatus.friend);
            expect(result).toBe(true);
        });

        it("should work for requested status", () => {
            const result = shouldSendNotification(null, RelationshipStatus.requested);
            expect(result).toBe(true);
        });
    });
});
