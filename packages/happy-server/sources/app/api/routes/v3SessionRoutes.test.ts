import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    createdAt: Date;
    updatedAt: Date;
};

const {
    state,
    emitUpdateMock,
    dbMock,
    resetState,
    seedSession,
    seedMessage
} = vi.hoisted(() => {
    const state = {
        sessions: [] as SessionRecord[],
        messages: [] as MessageRecord[],
        accountSeqById: new Map<string, number>(),
        nextMessageId: 1,
        nowMs: 1700000000000
    };

    const resetState = () => {
        state.sessions = [];
        state.messages = [];
        state.accountSeqById = new Map<string, number>();
        state.nextMessageId = 1;
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
    };

    const seedMessage = (input: {
        sessionId: string;
        seq: number;
        localId: string | null;
        content: unknown;
    }) => {
        const createdAt = new Date(state.nowMs);
        state.nowMs += 1;
        const msg: MessageRecord = {
            id: `seed-${state.nextMessageId}`,
            sessionId: input.sessionId,
            seq: input.seq,
            localId: input.localId,
            content: input.content,
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(msg);
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
        const row = state.sessions.find((session) => (
            session.id === args?.where?.id &&
            session.accountId === args?.where?.accountId
        ));
        if (!row) {
            return null;
        }
        return selectFields(row as unknown as Record<string, unknown>, args?.select) as SessionRecord;
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
        } else if (args?.orderBy?.seq === "desc") {
            rows.sort((a, b) => b.seq - a.seq);
        }
        if (args?.orderBy?.createdAt === "desc") {
            rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        if (typeof args?.take === "number") {
            rows = rows.slice(0, args.take);
        }

        return rows.map((row) => selectFields(row as unknown as Record<string, unknown>, args?.select));
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
            createdAt,
            updatedAt: createdAt
        };
        state.nextMessageId += 1;
        state.messages.push(row);
        return selectFields(row as unknown as Record<string, unknown>, args?.select);
    });

    const txClient = {
        session: {
            update: sessionUpdate
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate
        },
        account: {
            update: accountUpdate
        }
    };

    const dbMock = {
        session: {
            findFirst: sessionFindFirst,
            update: sessionUpdate
        },
        account: {
            update: accountUpdate
        },
        sessionMessage: {
            findMany: sessionMessageFindMany,
            create: sessionMessageCreate
        },
        $transaction: vi.fn(async (fn: any) => fn(txClient))
    };

    const emitUpdateMock = vi.fn();

    return {
        state,
        emitUpdateMock,
        dbMock,
        resetState,
        seedSession,
        seedMessage
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
        emitUpdate: emitUpdateMock
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
    }))
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

    beforeEach(() => {
        resetState();
        emitUpdateMock.mockClear();
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
    });

    it("reads messages in seq order from the beginning", async () => {
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
        expect(body.messages.map((message: any) => message.seq)).toEqual([1, 2]);
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
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
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
        expect(emitUpdateMock).toHaveBeenCalledTimes(3);
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
        expect(emitUpdateMock).toHaveBeenCalledTimes(1);
    });

    it("supports reverse pagination with before_seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 10; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();

        // Get the latest 3 messages (before seq 11 = all, limited to 3)
        const page1 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=11&limit=3",
            headers: { "x-user-id": "user-1" }
        });
        const body1 = page1.json();
        expect(body1.messages.map((m: any) => m.seq)).toEqual([8, 9, 10]);
        expect(body1.hasMore).toBe(true);

        // Get the next 3 older messages
        const page2 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=8&limit=3",
            headers: { "x-user-id": "user-1" }
        });
        const body2 = page2.json();
        expect(body2.messages.map((m: any) => m.seq)).toEqual([5, 6, 7]);
        expect(body2.hasMore).toBe(true);

        // Get the remaining older messages
        const page3 = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=5&limit=10",
            headers: { "x-user-id": "user-1" }
        });
        const body3 = page3.json();
        expect(body3.messages.map((m: any) => m.seq)).toEqual([1, 2, 3, 4]);
        expect(body3.hasMore).toBe(false);
    });

    it("rejects specifying both after_seq and before_seq", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        app = await createApp();

        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?after_seq=0&before_seq=10",
            headers: { "x-user-id": "user-1" }
        });
        expect(response.statusCode).toBe(400);
    });

    it("returns latest messages when no cursor params specified (with limit)", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        for (let seq = 1; seq <= 10; seq += 1) {
            seedMessage({ sessionId: "session-1", seq, localId: `l${seq}`, content: { t: "encrypted", c: String(seq) } });
        }

        app = await createApp();

        // No after_seq or before_seq, just limit=3 → latest 3 messages
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?limit=3",
            headers: { "x-user-id": "user-1" }
        });
        const body = response.json();
        expect(response.statusCode).toBe(200);
        expect(body.messages.map((m: any) => m.seq)).toEqual([8, 9, 10]);
        expect(body.hasMore).toBe(true);
    });

    it("returns empty results for before_seq=1 (no messages before seq 1)", async () => {
        seedSession({ id: "session-1", accountId: "user-1" });
        seedMessage({ sessionId: "session-1", seq: 1, localId: "l1", content: { t: "encrypted", c: "a" } });

        app = await createApp();
        const response = await app.inject({
            method: "GET",
            url: "/v3/sessions/session-1/messages?before_seq=1",
            headers: { "x-user-id": "user-1" }
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.messages).toEqual([]);
        expect(body.hasMore).toBe(false);
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
                messages: Array.from({ length: 101 }, (_, index) => ({
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
});
