import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    dbMock,
    allocateUserSeqMock,
    emitUpdateSpy,
    emitEphemeralSpy,
    sessionDeleteMock,
    sessionArchiveMock,
} = vi.hoisted(() => ({
    dbMock: {
        session: {
            findMany: vi.fn(),
            findFirst: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        sessionMessage: {
            findMany: vi.fn(),
        },
    },
    allocateUserSeqMock: vi.fn(),
    emitUpdateSpy: vi.fn(),
    emitEphemeralSpy: vi.fn(),
    sessionDeleteMock: vi.fn(),
    sessionArchiveMock: vi.fn(),
}));

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock("@/app/session/sessionDelete", () => ({ sessionDelete: sessionDeleteMock }));
vi.mock("@/app/session/sessionArchive", () => ({ sessionArchive: sessionArchiveMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return { ...actual, eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: emitEphemeralSpy } };
});

import { sessionRoutes } from "./sessionRoutes";

beforeEach(() => {
    vi.clearAllMocks();
});

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

    // These cases are about the account path, so the session-scope decorator
    // stands in as the same account-only check. It has to be present: the
    // routes refuse to register without it rather than losing their preHandler.
    typed.decorate("authenticateSessionScope", (typed as any).authenticate);

    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("sessionRoutes", () => {
    it("registers all routes without duplicate method/path pairs", async () => {
        const app = await createApp();

        expect(app.hasRoute({ method: "POST", url: "/v1/sessions/:sessionId/archive" })).toBe(true);
        expect(app.hasRoute({ method: "POST", url: "/v2/sessions/lookup" })).toBe(true);

        await app.close();
    });

    it("looks up requested sessions owned by the authenticated account", async () => {
        dbMock.session.findMany.mockResolvedValue([
            {
                id: "session-b",
                seq: 7,
                createdAt: new Date("2026-07-03T04:27:00.000Z"),
                updatedAt: new Date("2026-07-03T06:57:00.000Z"),
                metadata: "encrypted-metadata-b",
                metadataVersion: 2,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: Buffer.from("key-b"),
                active: false,
                lastActiveAt: new Date("2026-07-03T06:57:00.000Z"),
            },
            {
                id: "session-a",
                seq: 3,
                createdAt: new Date("2026-07-03T03:00:00.000Z"),
                updatedAt: new Date("2026-07-03T03:30:00.000Z"),
                metadata: "encrypted-metadata-a",
                metadataVersion: 1,
                agentState: "agent-state",
                agentStateVersion: 4,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: new Date("2026-07-03T03:30:00.000Z"),
            },
        ]);
        const app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v2/sessions/lookup",
            headers: { "x-user-id": "user-1" },
            payload: { ids: ["session-a", "session-b", "session-a"] },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.session.findMany).toHaveBeenCalledWith({
            where: {
                accountId: "user-1",
                id: { in: ["session-a", "session-b"] },
            },
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            },
        });
        expect(response.json()).toEqual({
            sessions: [
                {
                    id: "session-a",
                    seq: 3,
                    createdAt: Date.parse("2026-07-03T03:00:00.000Z"),
                    updatedAt: Date.parse("2026-07-03T03:30:00.000Z"),
                    active: true,
                    activeAt: Date.parse("2026-07-03T03:30:00.000Z"),
                    metadata: "encrypted-metadata-a",
                    metadataVersion: 1,
                    agentState: "agent-state",
                    agentStateVersion: 4,
                    dataEncryptionKey: null,
                },
                {
                    id: "session-b",
                    seq: 7,
                    createdAt: Date.parse("2026-07-03T04:27:00.000Z"),
                    updatedAt: Date.parse("2026-07-03T06:57:00.000Z"),
                    active: false,
                    activeAt: Date.parse("2026-07-03T06:57:00.000Z"),
                    metadata: "encrypted-metadata-b",
                    metadataVersion: 2,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: Buffer.from("key-b").toString("base64"),
                },
            ],
        });

        await app.close();
    });

    it("selects only requested account-owned ids and seq for a seq projection", async () => {
        dbMock.session.findMany.mockResolvedValue([
            { id: "session-b", seq: 7 },
            { id: "session-a", seq: 3 },
        ]);
        const app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v2/sessions/lookup",
            headers: { "x-user-id": "user-1" },
            payload: { ids: ["session-a", "session-b", "session-a"], projection: "seq" },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.session.findMany).toHaveBeenCalledExactlyOnceWith({
            where: { accountId: "user-1", id: { in: ["session-a", "session-b"] } },
            select: { id: true, seq: true },
        });
        expect(response.json()).toEqual({
            sessions: [{ id: "session-a", seq: 3 }, { id: "session-b", seq: 7 }],
        });
        await app.close();
    });

    it("returns versions and cheap fields without encrypted bodies for a version projection", async () => {
        dbMock.session.findMany.mockResolvedValue([
            {
                id: "session-b",
                seq: 7,
                createdAt: new Date("2026-07-03T04:27:00.000Z"),
                updatedAt: new Date("2026-07-03T06:57:00.000Z"),
                metadataVersion: 2,
                agentStateVersion: 0,
                dataEncryptionKey: Buffer.from("key-b"),
                active: false,
                lastActiveAt: new Date("2026-07-03T06:57:00.000Z"),
            },
            {
                id: "session-a",
                seq: 3,
                createdAt: new Date("2026-07-03T03:00:00.000Z"),
                updatedAt: new Date("2026-07-03T03:30:00.000Z"),
                metadataVersion: 1,
                agentStateVersion: 4,
                dataEncryptionKey: null,
                active: true,
                lastActiveAt: new Date("2026-07-03T03:30:00.000Z"),
            },
        ]);
        const app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v2/sessions/lookup",
            headers: { "x-user-id": "user-1" },
            payload: { ids: ["session-a", "session-b", "session-a"], projection: "version" },
        });

        expect(response.statusCode).toBe(200);
        expect(dbMock.session.findMany).toHaveBeenCalledExactlyOnceWith({
            where: { accountId: "user-1", id: { in: ["session-a", "session-b"] } },
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadataVersion: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
            },
        });
        expect(response.json()).toEqual({
            sessions: [
                {
                    id: "session-a",
                    seq: 3,
                    createdAt: Date.parse("2026-07-03T03:00:00.000Z"),
                    updatedAt: Date.parse("2026-07-03T03:30:00.000Z"),
                    active: true,
                    activeAt: Date.parse("2026-07-03T03:30:00.000Z"),
                    metadataVersion: 1,
                    agentStateVersion: 4,
                    hasDataEncryptionKey: false,
                },
                {
                    id: "session-b",
                    seq: 7,
                    createdAt: Date.parse("2026-07-03T04:27:00.000Z"),
                    updatedAt: Date.parse("2026-07-03T06:57:00.000Z"),
                    active: false,
                    activeAt: Date.parse("2026-07-03T06:57:00.000Z"),
                    metadataVersion: 2,
                    agentStateVersion: 0,
                    hasDataEncryptionKey: true,
                },
            ],
        });
        await app.close();
    });

    it.each([
        { ids: [], projection: "seq" },
        { ids: [""], projection: "seq" },
        { ids: Array.from({ length: 201 }, (_, i) => `session-${i}`), projection: "seq" },
        { ids: ["session-a"], projection: "metadata" },
    ])("rejects invalid projection lookup input %# before querying sessions", async (payload) => {
        const app = await createApp();
        const response = await app.inject({
            method: "POST",
            url: "/v2/sessions/lookup",
            headers: { "x-user-id": "user-1" },
            payload,
        });
        expect(response.statusCode).toBe(400);
        expect(dbMock.session.findMany).not.toHaveBeenCalled();
        await app.close();
    });

    it.each([undefined, "seq", "version"])("rejects lookup requests without authentication (projection %s)", async (projection) => {
        const app = await createApp();

        const response = await app.inject({
            method: "POST",
            url: "/v2/sessions/lookup",
            payload: { ids: ["session-a"], ...(projection ? { projection } : {}) },
        });

        expect(response.statusCode).toBe(401);
        expect(dbMock.session.findMany).not.toHaveBeenCalled();

        await app.close();
    });
});
