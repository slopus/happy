import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock inTx so the action runs against an in-memory fake tx.
// afterTx is captured and invoked immediately after the fn completes
// (mirrors the real behaviour: callbacks run after tx commits).
let currentTx: any = null;
let afterTxCallbacks: Array<() => void> = [];

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: any) => Promise<unknown>) => {
        afterTxCallbacks = [];
        const result = await fn(currentTx);
        // Run any registered afterTx callbacks (simulating post-commit flush)
        for (const cb of afterTxCallbacks) {
            cb();
        }
        return result;
    },
    afterTx: (_tx: any, cb: () => void) => {
        afterTxCallbacks.push(cb);
    },
}));

// Mock the event router — factory cannot reference outer variables because
// vi.mock is hoisted. Access the spy via the imported module after setup.
vi.mock("@/app/events/eventRouter", () => ({
    buildSessionActivityEphemeral: vi.fn((sessionId: string, active: boolean, activeAt: number, thinking?: boolean) => ({
        type: "activity",
        id: sessionId,
        active,
        activeAt,
        thinking,
    })),
    eventRouter: {
        emitEphemeral: vi.fn(),
    },
}));

// Mock persistSessionEvent — side-effect only, returns a resolved promise.
vi.mock("@/app/events/persistSessionEvent", () => ({
    persistSessionEvent: vi.fn().mockResolvedValue({ id: "evt-1", seq: 1, createdAt: new Date() }),
}));

import { sessionArchive } from "./sessionArchive";
import { SESSION_EVENT_TYPES } from "@/app/events/sessionEventTypes";
import { eventRouter } from "@/app/events/eventRouter";
import { persistSessionEvent } from "@/app/events/persistSessionEvent";

function makeCtx(uid: string) {
    return { uid } as any;
}

function makeSession(overrides: Partial<{
    id: string;
    accountId: string;
    active: boolean;
    lastActiveAt: Date;
}> = {}) {
    return {
        id: "session-1",
        accountId: "user-1",
        active: true,
        lastActiveAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...overrides,
    };
}

describe("sessionArchive", () => {
    beforeEach(() => {
        currentTx = null;
        afterTxCallbacks = [];
        vi.mocked(eventRouter.emitEphemeral).mockClear();
        vi.mocked(persistSessionEvent).mockClear();
    });

    // Scenario 1: active session is archived
    it("returns true when archiving an active session", async () => {
        // Why: the caller (route layer) maps true→200 {success:true}, so the
        // return value must be true for a successful archive.
        const session = makeSession({ id: "session-1", accountId: "user-1", active: true });
        const updateMock = vi.fn().mockResolvedValue({ ...session, active: false });
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: updateMock,
            },
        };

        const result = await sessionArchive(makeCtx("user-1"), "session-1");

        expect(result).toBe(true);
    });

    it("marks the session active=false and updates lastActiveAt when archiving an active session", async () => {
        // Why: DB must reflect archived state; lastActiveAt is the timestamp
        // mirrored to clients via the session-activity ephemeral.
        const session = makeSession({ id: "session-1", accountId: "user-1", active: true });
        const updateMock = vi.fn().mockResolvedValue({ ...session, active: false });
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: updateMock,
            },
        };

        await sessionArchive(makeCtx("user-1"), "session-1");

        expect(updateMock).toHaveBeenCalledOnce();
        const call = updateMock.mock.calls[0][0];
        expect(call.where).toEqual({ id: "session-1" });
        expect(call.data.active).toBe(false);
        expect(call.data.lastActiveAt).toBeInstanceOf(Date);
    });

    it("emits a session-activity(active=false) ephemeral to user-scoped-only after archiving", async () => {
        // Why: clients need the real-time push to remove the session from their
        // active list immediately. The recipientFilter must be user-scoped-only
        // (mirrors the socket session-end handler behaviour documented in spec).
        const session = makeSession({ id: "session-1", accountId: "user-1", active: true });
        const updateMock = vi.fn().mockResolvedValue({ ...session, active: false });
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: updateMock,
            },
        };

        await sessionArchive(makeCtx("user-1"), "session-1");

        expect(vi.mocked(eventRouter.emitEphemeral)).toHaveBeenCalledOnce();
        const emitArgs = vi.mocked(eventRouter.emitEphemeral).mock.calls[0][0];
        expect(emitArgs.userId).toBe("user-1");
        expect(emitArgs.recipientFilter).toEqual({ type: "user-scoped-only" });
        expect(emitArgs.payload.active).toBe(false);
        expect(emitArgs.payload.id).toBe("session-1");
    });

    it("persists a SESSION_END event after archiving an active session", async () => {
        // Why: the durable event log records the session lifecycle; downstream
        // readers (analytics, auditing) rely on this entry.
        const session = makeSession({ id: "session-1", accountId: "user-1", active: true });
        const updateMock = vi.fn().mockResolvedValue({ ...session, active: false });
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: updateMock,
            },
        };

        await sessionArchive(makeCtx("user-1"), "session-1");

        expect(vi.mocked(persistSessionEvent)).toHaveBeenCalledOnce();
        const persistArgs = vi.mocked(persistSessionEvent).mock.calls[0][0];
        expect(persistArgs.sessionId).toBe("session-1");
        expect(persistArgs.eventType).toBe(SESSION_EVENT_TYPES.SESSION_END);
    });

    // Scenario 2: idempotent — already inactive session
    it("returns true without any DB update when the session is already inactive (idempotent)", async () => {
        // Why: the caller may retry (e.g. project-delete runs archive-sessions
        // twice). Re-emitting events for an already-archived session would
        // confuse clients; re-updating the row is wasteful.
        const session = makeSession({ id: "session-1", accountId: "user-1", active: false });
        const updateMock = vi.fn();
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: updateMock,
            },
        };

        const result = await sessionArchive(makeCtx("user-1"), "session-1");

        expect(result).toBe(true);
        expect(updateMock).not.toHaveBeenCalled();
    });

    it("does not emit or persist events when the session is already inactive", async () => {
        // Why: duplicate events would create phantom SESSION_END entries in the
        // event log and trigger spurious socket notifications on the client.
        const session = makeSession({ id: "session-1", accountId: "user-1", active: false });
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(session),
                update: vi.fn(),
            },
        };

        await sessionArchive(makeCtx("user-1"), "session-1");

        expect(vi.mocked(eventRouter.emitEphemeral)).not.toHaveBeenCalled();
        expect(vi.mocked(persistSessionEvent)).not.toHaveBeenCalled();
    });

    // Scenario 3: not owned / not found
    it("returns false when the session belongs to a different account", async () => {
        // Why: the route maps false→404 to prevent cross-account data leakage.
        // The query filters by both id AND accountId, so a different owner's
        // session is indistinguishable from a missing one from this caller's POV.
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(null), // other owner: not returned
                update: vi.fn(),
            },
        };

        const result = await sessionArchive(makeCtx("user-2"), "session-1");

        expect(result).toBe(false);
    });

    it("does not modify any session when the caller does not own it", async () => {
        // Why: misrouted requests must be entirely inert — no side effects.
        const updateMock = vi.fn();
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(null),
                update: updateMock,
            },
        };

        await sessionArchive(makeCtx("user-2"), "session-1");

        expect(updateMock).not.toHaveBeenCalled();
        expect(vi.mocked(eventRouter.emitEphemeral)).not.toHaveBeenCalled();
        expect(vi.mocked(persistSessionEvent)).not.toHaveBeenCalled();
    });

    it("returns false when the sessionId does not exist at all", async () => {
        // Why: non-existent session is the same false path as wrong owner;
        // both map to 404 at the route layer.
        currentTx = {
            session: {
                findFirst: vi.fn().mockResolvedValue(null),
                update: vi.fn(),
            },
        };

        const result = await sessionArchive(makeCtx("user-1"), "nonexistent-session");

        expect(result).toBe(false);
    });
});
