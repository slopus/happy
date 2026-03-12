import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    state,
    dbMock,
    emitEphemeralToSessionSubscribersMock,
    resetState
} = vi.hoisted(() => {
    const state = {
        messages: [] as Array<{ id: string; sessionId: string; createdAt: Date }>,
        sessions: [] as Array<{ id: string; accountId: string }>,
        deliveryIssues: [] as Array<{ sessionMessageId: string; status: "waiting" | "error"; reason: string | null }>
    };

    const resetState = () => {
        state.messages = [];
        state.sessions = [];
        state.deliveryIssues = [];
    };

    const issueFindMany = vi.fn(async () => {
        return state.deliveryIssues.map((issue) => {
            const message = state.messages.find((item) => item.id === issue.sessionMessageId);
            const session = message
                ? state.sessions.find((item) => item.id === message.sessionId)
                : null;
            return {
                sessionMessageId: issue.sessionMessageId,
                status: issue.status,
                reason: issue.reason,
                sessionMessage: message
                    ? {
                        id: message.id,
                        localId: null,
                        sessionId: message.sessionId,
                        createdAt: message.createdAt,
                        session: session
                            ? { id: session.id, accountId: session.accountId }
                            : null
                    }
                    : null
            };
        });
    });

    const issueUpdateMany = vi.fn(async (args: any) => {
        let count = 0;
        for (const issue of state.deliveryIssues) {
            if (issue.sessionMessageId !== args?.where?.sessionMessageId) {
                continue;
            }
            if (args?.where?.status && issue.status !== args.where.status) {
                continue;
            }
            issue.status = args?.data?.status ?? issue.status;
            issue.reason = args?.data?.reason ?? issue.reason;
            count += 1;
        }
        return { count };
    });

    const dbMock = {
        sessionMessageDeliveryIssue: {
            findMany: issueFindMany,
            updateMany: issueUpdateMany
        }
    };

    const emitEphemeralToSessionSubscribersMock = vi.fn(async () => undefined);

    return {
        state,
        dbMock,
        emitEphemeralToSessionSubscribersMock,
        resetState
    };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        emitEphemeralToSessionSubscribers: emitEphemeralToSessionSubscribersMock
    },
    buildMessageDeliveryErrorEphemeral: vi.fn((sid: string, messageId: string, localId: string | null, error: string) => ({
        type: "message-delivery-error",
        sid,
        messageId,
        localId,
        error
    }))
}));

import { markTimedOutDeliveryIssues } from "./timeout";

describe("messageDelivery timeout", () => {
    beforeEach(() => {
        resetState();
        emitEphemeralToSessionSubscribersMock.mockClear();
    });

    it("marks waiting issue older than 60s as error/ack_timeout", async () => {
        state.sessions.push({ id: "session-1", accountId: "user-1" });
        state.messages.push({ id: "msg-1", sessionId: "session-1", createdAt: new Date(1000) });
        state.deliveryIssues.push({ sessionMessageId: "msg-1", status: "waiting", reason: null });

        await markTimedOutDeliveryIssues(Date.now() + 61_000);

        expect(state.deliveryIssues).toEqual([
            {
                sessionMessageId: "msg-1",
                status: "error",
                reason: "ack_timeout"
            }
        ]);
        expect(emitEphemeralToSessionSubscribersMock).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting issue unchanged when not timed out", async () => {
        const now = Date.now();
        state.sessions.push({ id: "session-1", accountId: "user-1" });
        state.messages.push({ id: "msg-1", sessionId: "session-1", createdAt: new Date(now - 59_000) });
        state.deliveryIssues.push({ sessionMessageId: "msg-1", status: "waiting", reason: null });

        await markTimedOutDeliveryIssues(now);

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
