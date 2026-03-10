import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionRoutes } from "./sessionRoutes";

const { sessionArchiveMock } = vi.hoisted(() => ({
    sessionArchiveMock: vi.fn()
}));

vi.mock("@/storage/db", () => ({
    db: {}
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {},
    buildNewSessionUpdate: vi.fn()
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

vi.mock("@/utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id")
}));

vi.mock("@/storage/seq", () => ({
    allocateUserSeq: vi.fn()
}));

vi.mock("@/app/session/sessionDelete", () => ({
    sessionDelete: vi.fn()
}));

vi.mock("@/app/session/sessionArchive", () => ({
    sessionArchive: sessionArchiveMock
}));

describe("sessionRoutes archive endpoint", () => {
    beforeEach(() => {
        sessionArchiveMock.mockReset();
    });

    async function createApp() {
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate("authenticate", async (request: any) => {
            request.userId = "user-1";
        });

        sessionRoutes(app as any);
        await app.ready();
        return app;
    }

    it("archives a session through the HTTP route", async () => {
        const app = await createApp();
        sessionArchiveMock.mockResolvedValue({ found: true, changed: true });

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions/session-1/archive"
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true });
        expect(sessionArchiveMock).toHaveBeenCalledWith(expect.objectContaining({ uid: "user-1" }), "session-1");

        await app.close();
    });

    it("returns 404 when the session does not exist", async () => {
        const app = await createApp();
        sessionArchiveMock.mockResolvedValue({ found: false, changed: false });

        const response = await app.inject({
            method: "POST",
            url: "/v1/sessions/missing-session/archive"
        });

        expect(response.statusCode).toBe(404);

        await app.close();
    });
});
