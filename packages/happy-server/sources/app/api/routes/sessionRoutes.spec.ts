import fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

type Session = {
    id: string;
    accountId: string;
    tag: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
};

const mocks = vi.hoisted(() => {
    const sessions = new Map<string, Session>();
    const activityCache = {
        clearSessionUpdates: vi.fn(),
        resumeSessionUpdates: vi.fn(),
    };
    const sessionDelete = vi.fn();

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) => Array.from(sessions.values()).find((session) =>
                session.accountId === where.accountId
                && (where.id === undefined || session.id === where.id)
                && (where.tag === undefined || session.tag === where.tag),
            ) ?? null),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            create: vi.fn(),
            update: vi.fn(async ({ where, data }: any) => {
                const session = sessions.get(where.id);
                if (!session) throw new Error("Session not found");
                const updated = { ...session, ...data, updatedAt: new Date() };
                sessions.set(updated.id, updated);
                return updated;
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                const session = sessions.get(where.id);
                if (!session || session.accountId !== where.accountId) return { count: 0 };
                sessions.set(session.id, { ...session, ...data, updatedAt: new Date() });
                return { count: 1 };
            }),
        },
        sessionMessage: { findMany: vi.fn() },
    };

    const reset = () => {
        sessions.clear();
        vi.clearAllMocks();
        sessionDelete.mockResolvedValue(false);
    };

    return { activityCache, dbMock, reset, sessionDelete, sessions };
});

vi.mock("@/storage/db", () => ({ db: mocks.dbMock }));
vi.mock("@/app/presence/sessionCache", () => ({ activityCache: mocks.activityCache }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: mocks.sessionDelete }));
vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral: vi.fn() },
    buildNewSessionUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
}));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: vi.fn() }));
vi.mock("@/utils/randomKeyNaked", () => ({ randomKeyNaked: vi.fn(() => "key") }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));

import { sessionRoutes } from "./sessionRoutes";

function seedSession(overrides: Partial<Session> = {}): Session {
    const session: Session = {
        id: "session-1",
        accountId: "owner-1",
        tag: "tag-1",
        seq: 1,
        metadata: "metadata",
        metadataVersion: 2,
        agentState: "state",
        agentStateVersion: 3,
        dataEncryptionKey: null,
        active: true,
        lastActiveAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
    };
    mocks.sessions.set(session.id, session);
    return session;
}

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app as unknown as Fastify;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("sessionRoutes lifecycle cache coordination", () => {
    let app: Fastify;

    beforeEach(() => {
        mocks.reset();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it("does not suppress another account's heartbeats when archiving its session", async () => {
        seedSession();
        app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions/session-1/archive",
            headers: { "x-user-id": "attacker-2" },
        });

        expect(response.statusCode).toBe(404);
        expect(mocks.activityCache.clearSessionUpdates).not.toHaveBeenCalled();
    });

    it("does not suppress another account's heartbeats when deleting its session", async () => {
        seedSession();
        app = await createApp();

        const response = await app.inject({
            method: "DELETE",
            url: "/v1/sessions/session-1",
            headers: { "x-user-id": "attacker-2" },
        });

        expect(response.statusCode).toBe(404);
        expect(mocks.activityCache.clearSessionUpdates).not.toHaveBeenCalled();
    });

    it("reactivates an existing inactive session before accepting its heartbeats", async () => {
        seedSession({ active: false, lastActiveAt: new Date("2026-01-01T00:00:00.000Z") });
        app = await createApp();
        const beforeRestart = Date.now();

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { "x-user-id": "owner-1" },
            payload: {
                tag: "tag-1",
                metadata: "new metadata is ignored for an existing tag",
                agentState: "new state is ignored for an existing tag",
            },
        });

        expect(response.statusCode).toBe(200);
        const restartTime = mocks.dbMock.session.update.mock.calls[0][0].data.lastActiveAt;
        expect(restartTime).toBeInstanceOf(Date);
        expect(restartTime.getTime()).toBeGreaterThanOrEqual(beforeRestart);
        expect(restartTime.getTime()).toBeLessThanOrEqual(Date.now());
        expect(mocks.dbMock.session.update).toHaveBeenCalledWith({
            where: { id: "session-1" },
            data: { active: true, lastActiveAt: restartTime },
        });
        expect(mocks.dbMock.session.update.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.activityCache.resumeSessionUpdates.mock.invocationCallOrder[0],
        );
        expect(mocks.activityCache.resumeSessionUpdates).toHaveBeenCalledWith("session-1");
        expect(response.json().session).toMatchObject({
            id: "session-1",
            active: true,
            activeAt: restartTime.getTime(),
        });
    });
});
