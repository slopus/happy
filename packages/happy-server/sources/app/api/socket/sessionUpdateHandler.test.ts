import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClientConnection } from "@/app/events/eventRouter";

const {
    state,
    dbMock,
    emitEphemeralToSessionSubscribersMock,
    resetState,
    createSocket
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        messages: [] as Array<{ id: string; sessionId: string; localId: string | null }>,
        deliveryIssues: [] as Array<{ sessionMessageId: string; status: "waiting" | "error"; reason: string | null }>
    };

    const resetState = () => {
        state.sessions = [];
        state.messages = [];
        state.deliveryIssues = [];
    };

    const sessionFindUnique = vi.fn(async (args: any) => {
        return state.sessions.find((session) => (
            session.id === args?.where?.id &&
            session.accountId === args?.where?.accountId
        )) ?? null;
    });

    const sessionMessageFindFirst = vi.fn(async (args: any) => {
        return state.messages.find((message) => (
            (!args?.where?.id || message.id === args.where.id) &&
            (!args?.where?.sessionId || message.sessionId === args.where.sessionId) &&
            (!args?.where?.localId || message.localId === args.where.localId)
        )) ?? null;
    });

    const deliveryIssueDeleteMany = vi.fn(async (args: any) => {
        const before = state.deliveryIssues.length;
        state.deliveryIssues = state.deliveryIssues.filter((item) => item.sessionMessageId !== args?.where?.sessionMessageId);
        return { count: before - state.deliveryIssues.length };
    });

    const deliveryIssueUpsert = vi.fn(async (args: any) => {
        const existing = state.deliveryIssues.find((item) => item.sessionMessageId === args?.where?.sessionMessageId);
        if (existing) {
            existing.status = args?.update?.status;
            existing.reason = args?.update?.reason ?? null;
            return existing;
        }

        const created = {
            sessionMessageId: args?.create?.sessionMessageId,
            status: args?.create?.status,
            reason: args?.create?.reason ?? null
        } as const;
        state.deliveryIssues.push({ ...created });
        return created;
    });

    const dbMock = {
        session: {
            findUnique: sessionFindUnique
        },
        sessionMessage: {
            findFirst: sessionMessageFindFirst
        },
        sessionMessageDeliveryIssue: {
            deleteMany: deliveryIssueDeleteMany,
            upsert: deliveryIssueUpsert
        }
    };

    const emitEphemeralToSessionSubscribersMock = vi.fn(async () => undefined);

    const createSocket = () => {
        const handlers = new Map<string, (...args: any[]) => unknown>();
        return {
            socket: {
                id: "socket-1",
                on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
                    handlers.set(event, handler);
                })
            } as any,
            async trigger(event: string, data: any) {
                const handler = handlers.get(event);
                if (!handler) {
                    throw new Error(`Missing handler for ${event}`);
                }
                await handler(data);
            }
        };
    };

    return {
        state,
        dbMock,
        emitEphemeralToSessionSubscribersMock,
        resetState,
        createSocket
    };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        getConnections: vi.fn(() => new Set()),
        emitEphemeralToSessionSubscribers: emitEphemeralToSessionSubscribersMock
    },
    buildSessionActivityEphemeral: vi.fn(),
    buildUpdateSessionUpdate: vi.fn(),
    buildNewMessageUpdate: vi.fn(),
    buildMessageSyncingEphemeral: vi.fn(),
    buildMessageSyncedEphemeral: vi.fn(),
    buildMessageErrorEphemeral: vi.fn(),
    buildMessageDeliveryErrorEphemeral: vi.fn((sid: string, messageId: string, localId: string | null, error: string) => ({
        type: "message-delivery-error",
        sid,
        messageId,
        localId,
        error
    }))
}));

vi.mock("@/storage/seq", () => ({
    allocateSessionSeq: vi.fn(async () => 1)
}));

vi.mock("@/app/monitoring/metrics2", () => ({
    websocketEventsCounter: { inc: vi.fn() },
    sessionAliveEventsCounter: { inc: vi.fn() }
}));

vi.mock("@/app/presence/sessionCache", () => ({
    activityCache: {
        isSessionValid: vi.fn(async () => true),
        queueSessionUpdate: vi.fn(),
    }
}));

vi.mock("@/utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id")
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

vi.mock("@/utils/delay", () => ({
    delay: vi.fn(async () => undefined)
}));

import { sessionUpdateHandler } from "./sessionUpdateHandler";

describe("sessionUpdateHandler message-receipt", () => {
    beforeEach(() => {
        resetState();
        emitEphemeralToSessionSubscribersMock.mockClear();
    });

    const createConnection = (socket: any): ClientConnection => ({
        connectionType: "session-scoped",
        socket,
        userId: "user-1",
        sessionId: "session-1",
        supportsMessageReceipt: true
    });

    it("removes waiting issue when receipt ok=true", async () => {
        state.sessions.push({ id: "session-1", accountId: "user-1" });
        state.messages.push({ id: "msg-1", sessionId: "session-1", localId: "l1" });
        state.deliveryIssues.push({ sessionMessageId: "msg-1", status: "waiting", reason: null });

        const { socket, trigger } = createSocket();
        sessionUpdateHandler("user-1", socket, createConnection(socket));

        await trigger("message-receipt", {
            sid: "session-1",
            messageId: "msg-1",
            ok: true
        });

        expect(state.deliveryIssues).toEqual([]);
    });

    it("stores error reason and emits ephemeral when receipt ok=false", async () => {
        state.sessions.push({ id: "session-1", accountId: "user-1" });
        state.messages.push({ id: "msg-1", sessionId: "session-1", localId: "l1" });
        state.deliveryIssues.push({ sessionMessageId: "msg-1", status: "waiting", reason: null });

        const { socket, trigger } = createSocket();
        sessionUpdateHandler("user-1", socket, createConnection(socket));

        await trigger("message-receipt", {
            sid: "session-1",
            messageId: "msg-1",
            localId: "l1",
            ok: false,
            error: "decrypt failed: invalid payload"
        });

        expect(state.deliveryIssues).toEqual([
            {
                sessionMessageId: "msg-1",
                status: "error",
                reason: "decrypt failed: invalid payload"
            }
        ]);
        expect(emitEphemeralToSessionSubscribersMock).toHaveBeenCalledTimes(1);
    });

    it("ignores invalid sid/messageId without mutating data", async () => {
        state.sessions.push({ id: "session-1", accountId: "user-1" });
        state.messages.push({ id: "msg-1", sessionId: "session-1", localId: "l1" });
        state.deliveryIssues.push({ sessionMessageId: "msg-1", status: "waiting", reason: null });

        const { socket, trigger } = createSocket();
        sessionUpdateHandler("user-1", socket, createConnection(socket));

        await trigger("message-receipt", {
            sid: "session-1",
            messageId: "msg-404",
            ok: false,
            error: "not found"
        });

        expect(state.deliveryIssues).toEqual([
            {
                sessionMessageId: "msg-1",
                status: "waiting",
                reason: null
            }
        ]);
        expect(emitEphemeralToSessionSubscribersMock).not.toHaveBeenCalled();
    });
});
