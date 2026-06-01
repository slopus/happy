import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock inTx so the action runs against an in-memory fake tx.
// Tests inject the fake by setting `currentTx` before calling the action.
let currentTx: any = null;
vi.mock("@/storage/inTx", () => ({
    inTx: (fn: (tx: any) => Promise<unknown>) => fn(currentTx)
}));

import { projectMemberInvite } from "./projectMemberInvite";

function makeCtx(uid: string) {
    return { uid } as any;
}

describe("projectMemberInvite", () => {
    beforeEach(() => {
        currentTx = null;
    });

    it("returns 'project-not-found' when the project does not exist", async () => {
        // Why: previously getProjectAsOwner conflated 'missing project' with
        // 'caller is not the owner', so the UI surfaced a misleading
        // "소유자만 초대할 수 있습니다" even when the project was simply
        // never created on happy-server (web-ui-only state). The contract
        // must distinguish the two so the UI can react correctly (and so a
        // backfill flow can detect the gap).
        currentTx = {
            project: { findUnique: vi.fn().mockResolvedValue(null) },
            projectMember: {
                findUnique: vi.fn(),
                create: vi.fn()
            },
            account: { findFirst: vi.fn() }
        };

        const result = await projectMemberInvite(
            makeCtx("user-1"),
            "missing-project",
            { username: "target" },
            "editor"
        );

        expect(result).toEqual({ ok: false, error: "project-not-found" });
        // The action must short-circuit before touching account/projectMember.
        expect(currentTx.account.findFirst).not.toHaveBeenCalled();
        expect(currentTx.projectMember.create).not.toHaveBeenCalled();
    });

    it("returns 'not-owner' when the project exists but caller lacks ownership", async () => {
        currentTx = {
            project: {
                findUnique: vi.fn().mockResolvedValue({
                    id: "p1",
                    accountId: "someone-else"
                })
            },
            projectMember: {
                findUnique: vi.fn().mockResolvedValue(null),
                create: vi.fn()
            },
            account: { findFirst: vi.fn() }
        };

        const result = await projectMemberInvite(
            makeCtx("user-1"),
            "p1",
            { username: "target" },
            "editor"
        );

        expect(result).toEqual({ ok: false, error: "not-owner" });
        expect(currentTx.account.findFirst).not.toHaveBeenCalled();
    });
});
