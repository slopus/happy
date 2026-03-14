import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionTurnRuntimeForTests, markTurnStarted } from "@/app/presence/sessionTurnRuntime";
import { type Fastify } from "../types";

type SessionRecord = {
    id: string;
    accountId: string;
    seq: number;
};

type MessageRecord = {
    id: string;
    sessionId: string;
    seq: number;
    localId: string | null;
    content: unknown;
    sentBy: string | null;
    sentByName: string | null;
    createdAt: Date;
    updatedAt: Date;
};

type DeliveryIssueRecord = {
    id: string;
    sessionMessageId: string;
    status: "waiting" | "error";
    reason: string | null;
    extra: unknown;
};

type PendingMessageRecord = {
    id: string;
    sessionId: string;
    localId: string;
    content: unknown;
    sentBy: string | null;
    sentByName: string | null;
    trackCliDelivery: boolean;
    pinnedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

const {
    state,
    emitToSessionSubscribersMock,
    canSendMessagesMock,
    replayFirstMessageToCliWhenConnectedMock,
    dbMock,
    resetState,
    seedSession,
    seedMessage,
    seedPendingMessage,
    seedDeliveryIssue
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        messages: [] as MessageRecord[],
        pendingMessages: [] as PendingMessageRecord[],
        deliveryIssues: [] as DeliveryIssueRecord[],
        accounts: [] as Array<{ id: string; firstName: string | null; username: string | null }>,
        accountSeqById: new Map<string, number>(),
        nextMessageId: 1,
        nextPendingMessageId: 1,
        nextDeliveryIssueId: 1,
        emitOwnerSessionScoped: 1,
        connections: [] as Array<{
            connectionType: "session-scoped";
            userId: string;
            sessionId: string;
            supportsMessageReceipt: boolean;
            socket: { emit: (...args: unknown[]) => void };
        }>,
        nowMs: 1700000000000
    };

    const resetState = () => {
        state.sessions = [];
        state.messages = [];
        state.pendingMessages = [];
        state.deliveryIssues = [];
        state.accounts = [];
        state.accountSeqById = new Map<string, number>();
        state.nextMessageId = 1;
        state.nextPendingMessageId = 1;
        state.nextDeliveryIssueId = 1;
        state.emitOwnerSessionScoped = 1;
        state.connections = [];
        state.nowMs = 1700000000000;
    };

    const seedSession = (input: Partial<SessionRecord> & Pick<SessionRecord, "id" | "accountId">) => {
        state.sessions.push({
            id: input.id,
            accountId: input.accountId,
            seq: input.seq ?? 0
        });
        if (!state.accountSeqById.has(input.accountId)) {
            state.accountSeqById.set(input.accountId, 0);
        }
        if (!state.accounts.some((account) => account.id === input.accountId)) {
            state.accounts.push({
                id: input.accountId,
                firstName: null,
                username: `user-${input.accountId}`
            });
        }
    };

    const seedMessage = (input: {
        sessionId: string;
        seq: number;
        localId: string | null;
        content: unknown;
        sentBy?: string | null;
        sentByName?: string | null;
    }) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const msg: MessageRecord = {
            id: `seed-${state.nextMessageId}`,
            sessionId: input.sessionId,
            seq: input.seq,
            localId: input.localId,
            content: input.content,
            sentBy: input.sentBy ?? null,
            sentByName: input.sentByName ?? null,
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(msg);
    };

    const seedPendingMessage = (input: {
        sessionId: string;
        localId: string;
        content: unknown;
        sentBy?: string | null;
        sentByName?: string | null;
        trackCliDelivery?: boolean;
        pinnedAt?: Date | null;
        createdAt?: Date;
    }) => {
        const createdAt = input.createdAt ?? new Date(state.nowMs);
        state.nowMs = Math.max(state.nowMs + 1, createdAt.getTime() + 1);
        const msg: PendingMessageRecord = {
            id: `pending-${state.nextPendingMessageId}`,
            sessionId: input.sessionId,
            localId: input.localId,
            content: input.content,
            sentBy: input.sentBy ?? null,
            sentByName: input.sentByName ?? null,
            trackCliDelivery: input.trackCliDelivery ?? false,
            pinnedAt: input.pinnedAt ?? null,
            createdAt,
            updatedAt: createdAt,
        };
        state.nextPendingMessageId += 1;
        state.pendingMessages.push(msg);
        return msg;
    };

    const seedDeliveryIssue = (input: {
        sessionMessageId: string;
        status: "waiting" | "error";
        reason?: string | null;
        extra?: unknown;
    }) => {
        state.deliveryIssues.push({
            id: `issue-${state.nextDeliveryIssueId}`,
            sessionMessageId: input.sessionMessageId,
            status: input.status,
            reason: input.reason ?? null,
            extra: input.extra ?? null
        });
        state.nextDeliveryIssueId += 1;
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) => {
        if (!select) {
            return { ...row };
        }
        const picked: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) {
                picked[key] = row[key];
            }
        }
        return picked;
    };

    const sessionFindFirst = vi.fn(async (args: any) => {
        const ownerId = args?.where?.OR?.find((item: any) => typeof item?.accountId === "string")?.accountId;
        const row = state.sessions.find((session) => (
            session.id === args?.where?.id &&
            (!ownerId || session.accountId === ownerId)
        ));
        if (!row) {
            return null;
        }
        return selectFields(row as unknown as Record<string, unknown>, args?.select) as SessionRecord;
    });

    const sessionFindUnique = vi.fn(async (args: any) => {
        const row = state.sessions.find((session) => (
            session.id === args?.where?.id &&
            (!args?.where?.accountId || session.accountId === args.where.accountId)
        ));
        if (!row) {
            return null;
        }
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionUpdate = vi.fn(async (args: any) => {
        const session = state.sessions.find((item) => item.id === args?.where?.id);
        if (!session) {
            throw new Error("Session not found");
        }
        const increment = args?.data?.seq?.increment ?? 0;
        session.seq += increment;
        return selectFields(session as unknown as Record<string, unknown>, args?.select);
    });

    const accountUpdate = vi.fn(async (args: any) => {
        const accountId = args?.where?.id as string;
        const current = state.accountSeqById.get(accountId) ?? 0;
        const increment = args?.data?.seq?.increment ?? 0;
        const next = current + increment;
        state.accountSeqById.set(accountId, next);
        return selectFields({ seq: next }, args?.select);
    });

    const accountFindUnique = vi.fn(async (args: any) => {
        const account = state.accounts.find((item) => item.id === args?.where?.id);
        if (!account) {
            return null;
        }
        return selectFields(account as unknown as Record<string, unknown>, args?.select);
    });

    const sessionMessageFindMany = vi.fn(async (args: any) => {
        let rows = [...state.messages];

        if (args?.where?.sessionId) {
            rows = rows.filter((message) => message.sessionId === args.where.sessionId);
        }
        if (typeof args?.where?.seq?.gt === "number") {
            rows = rows.filter((message) => message.seq > args.where.seq.gt);
        }
        if (typeof args?.where?.seq?.lt === "number") {
            rows = rows.filter((message) => message.seq < args.where.seq.lt);
        }
        if (Array.isArray(args?.where?.localId?.in)) {
            const localIds = new Set(args.where.localId.in);
            rows = rows.filter((message) => localIds.has(message.localId));
        }
        if (args?.orderBy?.seq === "asc") {
            rows.sort((a, b) => a.seq - b.seq);
        }
        if (args?.orderBy?.seq === "desc") {
            rows.sort((a, b) => b.seq - a.seq);
        }
        if (args?.orderBy?.createdAt === "desc") {
            rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        if (typeof args?.take === "number") {
            rows = rows.slice(0, args.take);
        }

        return rows.map((row) => {
            const selected = selectFields(row as unknown as Record<string, unknown>, args?.select) as Record<string, unknown>;
            if (args?.select?.deliveryIssue) {
                const issue = state.deliveryIssues.find((item) => item.sessionMessageId === row.id) ?? null;
                if (typeof args.select.deliveryIssue === "object" && issue) {
                    selected.deliveryIssue = selectFields(issue as unknown as Record<string, unknown>, args.select.deliveryIssue.select);
                } else {
                    selected.deliveryIssue = issue;
                }
            }
            return selected;
        });
    });

    const sessionMessageCreate = vi.fn(async (args: any) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const row: MessageRecord = {
            id: `msg-${state.nextMessageId}`,
            sessionId: args?.data?.sessionId,
            seq: args?.data?.seq,
            localId: args?.data?.localId ?? null,
            content: args?.data?.content,
            sentBy: args?.data?.sentBy ?? null,
            sentByName: args?.data?.sentByName ?? null,
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionPendingMessageFindMany = vi.fn(async (args: any) => {
        let rows = [...state.pendingMessages];
        if (args?.where?.sessionId) {
            rows = rows.filter((message) => message.sessionId === args.where.sessionId);
        }
        if (typeof args?.where?.localId === "string") {
            rows = rows.filter((message) => message.localId === args.where.localId);
        }
        if (Array.isArray(args?.where?.localId?.in)) {
            const localIds = new Set(args.where.localId.in);
            rows = rows.filter((message) => localIds.has(message.localId));
        }
        if (args?.where?.pinnedAt?.not === null) {
            rows = rows.filter((message) => message.pinnedAt !== null);
        }
        if (args?.where?.pinnedAt === null) {
            rows = rows.filter((message) => message.pinnedAt === null);
        }

        const orderBy = args?.orderBy;
        if (Array.isArray(orderBy)) {
            rows.sort((a, b) => {
                for (const order of orderBy) {
                    if (order.pinnedAt) {
                        const aPinned = a.pinnedAt ? a.pinnedAt.getTime() : null;
                        const bPinned = b.pinnedAt ? b.pinnedAt.getTime() : null;
                        if (aPinned !== bPinned) {
                            if (aPinned === null) return 1;
                            if (bPinned === null) return -1;
                            return order.pinnedAt === "desc" ? bPinned - aPinned : aPinned - bPinned;
                        }
                    }
                    if (order.createdAt) {
                        const delta = a.createdAt.getTime() - b.createdAt.getTime();
                        if (delta !== 0) {
                            return order.createdAt === "desc" ? -delta : delta;
                        }
                    }
                }
                return 0;
            });
        }

        return rows.map((row) => selectFields(row as unknown as Record<string, unknown>, args?.select));
    });

    const sessionPendingMessageFindFirst = vi.fn(async (args: any) => {
        const rows = await sessionPendingMessageFindMany(args);
        return rows[0] ?? null;
    });

    const sessionPendingMessageFindUnique = vi.fn(async (args: any) => {
        const where = args?.where;
        let row: PendingMessageRecord | undefined;
        if (where?.id) {
            row = state.pendingMessages.find((message) => message.id === where.id);
        } else if (where?.sessionId_localId) {
            row = state.pendingMessages.find((message) => (
                message.sessionId === where.sessionId_localId.sessionId &&
                message.localId === where.sessionId_localId.localId
            ));
        }
        if (!row) return null;
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionPendingMessageCreate = vi.fn(async (args: any) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const row: PendingMessageRecord = {
            id: `pending-${state.nextPendingMessageId}`,
            sessionId: args?.data?.sessionId,
            localId: args?.data?.localId,
            content: args?.data?.content,
            sentBy: args?.data?.sentBy ?? null,
            sentByName: args?.data?.sentByName ?? null,
            trackCliDelivery: args?.data?.trackCliDelivery ?? false,
            pinnedAt: args?.data?.pinnedAt ?? null,
            createdAt,
            updatedAt: createdAt,
        };
        state.nextPendingMessageId += 1;
        state.pendingMessages.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionPendingMessageUpdate = vi.fn(async (args: any) => {
        const row = state.pendingMessages.find((message) => message.id === args?.where?.id);
        if (!row) {
            throw new Error("Pending message not found");
        }
        if (args?.data?.pinnedAt !== undefined) {
            row.pinnedAt = args.data.pinnedAt;
        }
        row.updatedAt = new Date(state.nowMs);
        state.nowMs += 1;
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const sessionPendingMessageDelete = vi.fn(async (args: any) => {
        const index = state.pendingMessages.findIndex((message) => message.id === args?.where?.id);
        if (index === -1) {
            throw new Error("Pending message not found");
        }
        const [deleted] = state.pendingMessages.splice(index, 1);
        return selectFields(deleted as unknown as Record<string, unknown>, args?.select);
    });

    const sessionPendingMessageDeleteMany = vi.fn(async (args: any) => {
        const before = state.pendingMessages.length;
        state.pendingMessages = state.pendingMessages.filter((message) => {
            if (args?.where?.id && message.id !== args.where.id) {
                return true;
            }
            if (args?.where?.sessionId && message.sessionId !== args.where.sessionId) {
                return true;
            }
            return false;
        });
        return { count: before - state.pendingMessages.length };
    });

    const deliveryIssueCreate = vi.fn(async (args: any) => {
        const record: DeliveryIssueRecord = {
            id: `issue-${state.nextDeliveryIssueId}`,
            sessionMessageId: args?.data?.sessionMessageId,
            status: args?.data?.status,
            reason: args?.data?.reason ?? null,
            extra: args?.data?.extra ?? null
        };
        state.nextDeliveryIssueId += 1;
        state.deliveryIssues.push(record);
        return record;
    });

    const deliveryIssueUpsert = vi.fn(async (args: any) => {
        const sessionMessageId = args?.where?.sessionMessageId;
        const existing = state.deliveryIssues.find((item) => item.sessionMessageId === sessionMessageId);
        if (existing) {
            existing.status = args?.update?.status ?? existing.status;
            existing.reason = args?.update?.reason ?? existing.reason;
            existing.extra = args?.update?.extra ?? existing.extra;
            return existing;
        }

        const created: DeliveryIssueRecord = {
            id: `issue-${state.nextDeliveryIssueId}`,
            sessionMessageId,
            status: args?.create?.status,
            reason: args?.create?.reason ?? null,
            extra: args?.create?.extra ?? null
        };
        state.nextDeliveryIssueId += 1;
        state.deliveryIssues.push(created);
        return created;
    });

    const deliveryIssueDelete = vi.fn(async (args: any) => {
        const index = state.deliveryIssues.findIndex((item) => item.sessionMessageId === args?.where?.sessionMessageId);
        if (index === -1) {
            throw new Error("Delivery issue not found");
        }
        const [deleted] = state.deliveryIssues.splice(index, 1);
        return deleted;
    });

    const txClient = {
        session: {
            update: sessionUpdate
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate
        },
        sessionPendingMessage: {
            findMany: sessionPendingMessageFindMany,
            findFirst: sessionPendingMessageFindFirst,
            findUnique: sessionPendingMessageFindUnique,
            create: sessionPendingMessageCreate,
            update: sessionPendingMessageUpdate,
            delete: sessionPendingMessageDelete,
            deleteMany: sessionPendingMessageDeleteMany,
        },
        sessionMessageDeliveryIssue: {
            create: deliveryIssueCreate,
            upsert: deliveryIssueUpsert,
            delete: deliveryIssueDelete
        },
        account: {
            update: accountUpdate
        }
    };

    const dbMock = {
        session: {
            findFirst: sessionFindFirst,
            findUnique: sessionFindUnique,
            update: sessionUpdate
        },
        account: {
            update: accountUpdate,
            findUnique: accountFindUnique
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate
        },
        sessionPendingMessage: {
            findMany: sessionPendingMessageFindMany,
            findFirst: sessionPendingMessageFindFirst,
            findUnique: sessionPendingMessageFindUnique,
            create: sessionPendingMessageCreate,
            update: sessionPendingMessageUpdate,
            delete: sessionPendingMessageDelete,
            deleteMany: sessionPendingMessageDeleteMany,
        },
        sessionMessageDeliveryIssue: {
            create: deliveryIssueCreate,
            upsert: deliveryIssueUpsert,
            delete: deliveryIssueDelete
        },
        $transaction: vi.fn(async (fn: any) => fn(txClient))
    };

    const emitToSessionSubscribersMock = vi.fn(async () => ({
        ownerDelivery: {
            total: 1,
            sessionScoped: state.emitOwnerSessionScoped
        }
    }));
    const canSendMessagesMock = vi.fn(async (userId: string, sessionId: string) => {
        return state.sessions.some((session) => session.id === sessionId && session.accountId === userId);
    });
    const replayFirstMessageToCliWhenConnectedMock = vi.fn(async () => false);

    return {
        state,
        emitToSessionSubscribersMock,
        canSendMessagesMock,
        replayFirstMessageToCliWhenConnectedMock,
        dbMock,
        resetState,
        seedSession,
        seedMessage,
        seedPendingMessage,
        seedDeliveryIssue
    };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id")
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {
        getConnections: vi.fn((userId: string) => {
            const matches = state.connections.filter((connection) => connection.userId === userId);
            return new Set(matches);
        }),
        emitToSessionSubscribers: emitToSessionSubscribersMock,
        emitEphemeralToSessionSubscribers: vi.fn(async () => undefined)
    },
    buildNewMessageUpdate: vi.fn((message: unknown, sessionId: string, updateSeq: number, updateId: string) => ({
        id: updateId,
        seq: updateSeq,
        body: {
            t: "new-message",
            sid: sessionId,
            message
        },
        createdAt: Date.now()
    })),
    buildMessageDeliveryErrorEphemeral: vi.fn((sid: string, messageId: string, localId: string | null, error: string) => ({
        type: "message-delivery-error",
        sid,
        messageId,
        localId,
        error
    })),
    buildPendingMessageUpsertEphemeral: vi.fn((sid: string, pending: unknown) => ({
        type: "pending-message-upsert",
        sid,
        pending,
    })),
    buildPendingMessageDeleteEphemeral: vi.fn((sid: string, pendingId: string) => ({
        type: "pending-message-delete",
        sid,
        pendingId,
    })),
}));

vi.mock("@/app/share/accessControl", () => ({
    canSendMessages: canSendMessagesMock
}));

vi.mock("./firstMessageReplay", () => ({
    replayFirstMessageToCliWhenConnected: replayFirstMessageToCliWhenConnectedMock,
    scheduleFirstMessageReplay: vi.fn(),
}));

import { v3SessionRoutes } from "./v3SessionRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    v3SessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("v3SessionRoutes", () => {
    let app: Fastify;
    const flushAsync = async () => {
        await Promise.resolve();
        await Promise.resolve();
    };

    beforeEach(() => {
        __resetSessionTurnRuntimeForTests();
        resetState();
        emitToSessionSubscribersMock.mockClear();
        canSendMessagesMock.mockClear();
        replayFirstMessageToCliWhenConnectedMock.mockClear();
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
    });

    it("returns latest messages in desc order when no cursor is provided", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 2, localId: "l2", content: { t: "encrypted", c: "b" } });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.hasMore).toBe(false);
        expect(body.messages.map((message: any) => message.seq)).toEqual([2, 1]);
    });

    it("supports cursor pagination with hasMore", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 5; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();
        const page1 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=0&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body1 = page1.json();
        expect(body1.messages.map((message: any) => message.seq)).toEqual([1, 2]);
        expect(body1.hasMore).toBe(true);

        const page2 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=2&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body2 = page2.json();
        expect(body2.messages.map((message: any) => message.seq)).toEqual([3, 4]);
        expect(body2.hasMore).toBe(true);

        const page3 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=4&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body3 = page3.json();
        expect(body3.messages.map((message: any) => message.seq)).toEqual([5]);
        expect(body3.hasMore).toBe(false);
    });

    it("supports backward pagination with before_seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 5; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();
        const page1 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=5&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body1 = page1.json();
        expect(body1.messages.map((message: any) => message.seq)).toEqual([4, 3]);
        expect(body1.hasMore).toBe(true);

        const page2 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=3&limit=2",
            headers: { "x-user-id": "user-1" }
        });
        const body2 = page2.json();
        expect(body2.messages.map((message: any) => message.seq)).toEqual([2, 1]);
        expect(body2.hasMore).toBe(false);
    });

    it("returns empty results for empty sessions and after_seq beyond latest", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const emptyResponse = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=1",
            headers: { "x-user-id": "user-1" }
        });

        expect(emptyResponse.statusCode).toBe(200);
        const body = emptyResponse.json();
        expect(body.messages).toEqual([]);
        expect(body.hasMore).toBe(false);
    });

    it("enforces read query bounds and auth/session ownership", async () => {
        seedSession({ id: "session-1", accountId: "owner-user" });
        app = await createApp();

        const invalidLimit = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?limit=0",
            headers: { "x-user-id": "owner-user" }
        });
        expect(invalidLimit.statusCode).toBe(400);

        const tooLargeLimit = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?limit=501",
            headers: { "x-user-id": "owner-user" }
        });
        expect(tooLargeLimit.statusCode).toBe(400);

        const conflictingCursors = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=1&before_seq=2",
            headers: { "x-user-id": "owner-user" }
        });
        expect(conflictingCursors.statusCode).toBe(400);

        const unauthorized = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages"
        });
        expect(unauthorized.statusCode).toBe(401);

        const wrongOwner = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "another-user" }
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("sends a single message and emits a new-message update", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-content-1" }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages).toHaveLength(1);
        expect(body.messages[0].seq).toBe(1);
        expect(body.messages[0].localId).toBe("l1");

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].content).toEqual({ t: "encrypted", c: "enc-content-1" });
        expect(emitToSessionSubscribersMock).toHaveBeenCalledTimes(1);
    });

    it("sends multiple messages with sequential seq numbers", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-1" },
                    { localId: "l2", content: "enc-2" },
                    { localId: "l3", content: "enc-3" }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2, 3]);
        expect(emitToSessionSubscribersMock).toHaveBeenCalledTimes(3);
    });

    it("deduplicates by localId and returns mixed existing/new messages sorted by seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "existing", content: { t: "encrypted", c: "old" } });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "new-1", content: "new-content" },
                    { localId: "existing", content: "ignored" }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages.map((message: any) => message.localId)).toEqual(["existing", "new-1"]);
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2]);
        expect(state.messages).toHaveLength(2);
        expect(emitToSessionSubscribersMock).toHaveBeenCalledTimes(1);
    });

    it("creates waiting delivery issue when trackCliDelivery=true and cli is connected", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        state.emitOwnerSessionScoped = 1;
        state.connections.push({
            connectionType: "session-scoped",
            userId: "user-1",
            sessionId: "session-1",
            supportsMessageReceipt: true,
            socket: { emit: vi.fn() }
        });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-content-1", trackCliDelivery: true }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        expect(state.deliveryIssues).toHaveLength(1);
        expect(state.deliveryIssues[0]).toMatchObject({
            sessionMessageId: state.messages[0].id,
            status: "waiting",
            reason: null
        });
    });

    it("marks delivery issue as error/no_cli_connection when no cli connection", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        state.emitOwnerSessionScoped = 0;

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-content-1", trackCliDelivery: true }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        expect(state.deliveryIssues).toHaveLength(1);
        expect(state.deliveryIssues[0]).toMatchObject({
            sessionMessageId: state.messages[0].id,
            status: "error",
            reason: "no_cli_connection"
        });
    });

    it("marks no_cli_connection immediately for non-first message without cli connection", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "existing", content: { t: "encrypted", c: "old" } });
        state.emitOwnerSessionScoped = 0;
        state.connections.push({
            connectionType: "session-scoped",
            userId: "user-1",
            sessionId: "session-1",
            supportsMessageReceipt: true,
            socket: { emit: vi.fn() }
        });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l2", content: "enc-content-2", trackCliDelivery: true }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        expect(state.deliveryIssues).toHaveLength(1);
        expect(state.deliveryIssues[0]).toMatchObject({
            sessionMessageId: state.messages.find((msg) => msg.localId === "l2")!.id,
            status: "error",
            reason: "no_cli_connection"
        });
    });

    it("does not create delivery issue when trackCliDelivery=false", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-content-1", trackCliDelivery: false }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        expect(state.deliveryIssues).toHaveLength(0);
    });

    it("skips waiting tracking when only legacy cli connection is present", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        state.emitOwnerSessionScoped = 1;
        state.connections.push({
            connectionType: "session-scoped",
            userId: "user-1",
            sessionId: "session-1",
            supportsMessageReceipt: false,
            socket: { emit: vi.fn() }
        });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" },
            payload: {
                messages: [
                    { localId: "l1", content: "enc-content-1", trackCliDelivery: true }
                ]
            }
        });

        expect(response.statusCode).toBe(200);
        expect(state.deliveryIssues).toHaveLength(0);
    });

    it("returns deliveryIssue in GET when issue record exists", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 1 });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });
        seedDeliveryIssue({
            sessionMessageId: state.messages[0].id,
            status: "error",
            reason: "ack_timeout"
        });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages[0].deliveryIssue).toEqual({
            status: "error",
            reason: "ack_timeout"
        });
    });

    it("enforces send validation limits and auth/session ownership", async () => {
        seedSession({ id: "session-1", accountId: "owner-user" });
        app = await createApp();

        const emptyBatch = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "owner-user" },
            payload: { messages: [] }
        });
        expect(emptyBatch.statusCode).toBe(400);

        const overLimitBatch = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "owner-user" },
            payload: {
                messages: Array.from({ length: 201 }, (_, index) => ({
                    localId: `l-${index}`,
                    content: `enc-${index}`
                }))
            }
        });
        expect(overLimitBatch.statusCode).toBe(400);

        const unauthorized = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            payload: {
                messages: [{ localId: "l1", content: "enc-1" }]
            }
        });
        expect(unauthorized.statusCode).toBe(401);

        const wrongOwner = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/messages",
            headers: { "x-user-id": "another-user" },
            payload: {
                messages: [{ localId: "l1", content: "enc-1" }]
            }
        });
        expect(wrongOwner.statusCode).toBe(404);
    });

    it("lists pending messages with pinned first then createdAt asc", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        seedPendingMessage({
            sessionId: "session-1",
            localId: "normal-old",
            content: { t: "encrypted", c: "normal-old" },
            createdAt: new Date("2026-03-12T10:00:00.000Z")
        });
        seedPendingMessage({
            sessionId: "session-1",
            localId: "pinned-old",
            content: { t: "encrypted", c: "pinned-old" },
            pinnedAt: new Date("2026-03-12T11:00:00.000Z"),
            createdAt: new Date("2026-03-12T10:05:00.000Z")
        });
        seedPendingMessage({
            sessionId: "session-1",
            localId: "pinned-new",
            content: { t: "encrypted", c: "pinned-new" },
            pinnedAt: new Date("2026-03-12T12:00:00.000Z"),
            createdAt: new Date("2026-03-12T10:10:00.000Z")
        });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/pending-messages",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages.map((message: any) => message.localId)).toEqual([
            "pinned-new",
            "pinned-old",
            "normal-old",
        ]);
    });

    it("routes /send to queued mode when pending queue is non-empty", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        seedPendingMessage({
            sessionId: "session-1",
            localId: "already-pending",
            content: { t: "encrypted", c: "pending-1" },
        });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/send",
            headers: { "x-user-id": "user-1" },
            payload: {
                localId: "new-send",
                content: "enc-content-new",
                trackCliDelivery: true,
            },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mode).toBe("queued");
        expect(state.pendingMessages.map((message) => message.localId)).toEqual(["new-send"]);
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].localId).toBe("already-pending");
    });

    it("routes /send to sent mode when queue empty and idle", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/send",
            headers: { "x-user-id": "user-1" },
            payload: {
                localId: "direct-send",
                content: "enc-content-direct",
                trackCliDelivery: false,
            },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mode).toBe("sent");
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].localId).toBe("direct-send");
    });

    it("routes /send to queued mode when session is busy (thinking/awaiting)", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        markTurnStarted("session-1");
        app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v3/sessions/session-1/send",
            headers: { "x-user-id": "user-1" },
            payload: {
                localId: "queued-by-thinking",
                content: "enc-content-thinking",
                trackCliDelivery: false,
            },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mode).toBe("queued");
        expect(state.messages).toHaveLength(0);
        expect(state.pendingMessages).toHaveLength(1);
        expect(state.pendingMessages[0].localId).toBe("queued-by-thinking");
    });

    it("send-now dispatches target pending message and keeps others", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        const p1 = seedPendingMessage({
            sessionId: "session-1",
            localId: "pending-1",
            content: { t: "encrypted", c: "pending-content-1" },
        });
        const p2 = seedPendingMessage({
            sessionId: "session-1",
            localId: "pending-2",
            content: { t: "encrypted", c: "pending-content-2" },
        });

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: `/v3/sessions/session-1/pending-messages/${p2.id}/send-now`,
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.mode).toBe("sent");
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].localId).toBe("pending-2");
        expect(state.pendingMessages.map((message) => message.id)).toEqual([p1.id]);
    });

    it("send-now returns 404 when pending item is consumed concurrently", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        const pending = seedPendingMessage({
            sessionId: "session-1",
            localId: "pending-race",
            content: { t: "encrypted", c: "pending-content-race" },
        });

        dbMock.sessionPendingMessage.deleteMany.mockImplementationOnce(async () => ({ count: 0 }));

        app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: `/v3/sessions/session-1/pending-messages/${pending.id}/send-now`,
            headers: { "x-user-id": "user-1" },
        });

        expect(response.statusCode).toBe(404);
        expect(state.messages).toHaveLength(0);
        expect(state.pendingMessages.map((message) => message.id)).toEqual([pending.id]);
    });

    it("pin and delete pending message endpoints update queue", async () => {
        seedSession({ id: "session-1", accountId: "user-1", seq: 0 });
        const pending = seedPendingMessage({
            sessionId: "session-1",
            localId: "pending-a",
            content: { t: "encrypted", c: "pending-content-a" },
        });

        app = await createApp();
        const pinResponse = await app.inject({
            method: "POST",
            url: `/v3/sessions/session-1/pending-messages/${pending.id}/pin`,
            headers: { "x-user-id": "user-1" },
        });
        expect(pinResponse.statusCode).toBe(200);
        expect(state.pendingMessages[0].pinnedAt).not.toBeNull();

        const unpinResponse = await app.inject({
            method: "POST",
            url: `/v3/sessions/session-1/pending-messages/${pending.id}/pin`,
            headers: { "x-user-id": "user-1" },
        });
        expect(unpinResponse.statusCode).toBe(200);
        expect(state.pendingMessages[0].pinnedAt).toBeNull();

        const deleteResponse = await app.inject({
            method: "DELETE",
            url: `/v3/sessions/session-1/pending-messages/${pending.id}`,
            headers: { "x-user-id": "user-1" },
        });
        expect(deleteResponse.statusCode).toBe(200);
        expect(state.pendingMessages).toHaveLength(0);
    });
});
