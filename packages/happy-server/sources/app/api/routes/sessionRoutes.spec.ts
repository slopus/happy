import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { describe, expect, it, vi } from "vitest";
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

    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe("sessionRoutes", () => {
    it("registers all routes without duplicate method/path pairs", async () => {
        const app = await createApp();

        expect(app.hasRoute({ method: "POST", url: "/v1/sessions/:sessionId/archive" })).toBe(true);

        await app.close();
    });
});
