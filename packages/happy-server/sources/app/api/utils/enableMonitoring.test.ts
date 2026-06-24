import fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enableMonitoring } from "./enableMonitoring";

const { dbMock } = vi.hoisted(() => ({
    dbMock: {
        $queryRaw: vi.fn()
    }
}));

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

describe("enableMonitoring health endpoints", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    });

    it("keeps liveness independent from database connectivity", async () => {
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/live" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server"
        });
        expect(dbMock.$queryRaw).not.toHaveBeenCalled();
    });

    it("checks database connectivity for readiness", async () => {
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/ready" });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: "ok",
            service: "happy-server"
        });
        expect(dbMock.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("returns unavailable when readiness dependency check fails", async () => {
        dbMock.$queryRaw.mockRejectedValueOnce(new Error("db down"));
        const app = fastify();
        enableMonitoring(app as never);

        const response = await app.inject({ method: "GET", url: "/ready" });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
            status: "error",
            service: "happy-server",
            error: "Database connectivity failed"
        });
    });
});
