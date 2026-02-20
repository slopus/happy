import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

// ─── In-memory token store ──────────────────────────────────────────────

type TokenRecord = {
    accountId: string;
    vendor: string;
    token: string;
    updatedAt: Date;
};

const { dbMock, resetState, state } = vi.hoisted(() => {
    const state = {
        tokens: [] as TokenRecord[],
    };

    const resetState = () => {
        state.tokens = [];
    };

    const upsert = vi.fn(async (args: any) => {
        const { accountId, vendor } = args.where.accountId_vendor;
        const idx = state.tokens.findIndex(
            (t) => t.accountId === accountId && t.vendor === vendor
        );
        if (idx >= 0) {
            state.tokens[idx].token = args.update.token;
            state.tokens[idx].updatedAt = args.update.updatedAt;
            return state.tokens[idx];
        }
        const record: TokenRecord = {
            accountId: args.create.accountId,
            vendor: args.create.vendor,
            token: args.create.token,
            updatedAt: new Date(),
        };
        state.tokens.push(record);
        return record;
    });

    const findUnique = vi.fn(async (args: any) => {
        const { accountId, vendor } = args.where.accountId_vendor;
        const record = state.tokens.find(
            (t) => t.accountId === accountId && t.vendor === vendor
        );
        if (!record) return null;
        // Respect select clause
        if (args.select) {
            const result: Record<string, unknown> = {};
            for (const [key, enabled] of Object.entries(args.select)) {
                if (enabled) result[key] = (record as any)[key];
            }
            return result;
        }
        return record;
    });

    const deleteOne = vi.fn(async (args: any) => {
        const { accountId, vendor } = args.where.accountId_vendor;
        const idx = state.tokens.findIndex(
            (t) => t.accountId === accountId && t.vendor === vendor
        );
        if (idx >= 0) {
            const removed = state.tokens.splice(idx, 1);
            return removed[0];
        }
        throw new Error("Record not found");
    });

    const findMany = vi.fn(async (args: any) => {
        return state.tokens
            .filter((t) => t.accountId === args.where.accountId)
            .map((t) => ({ vendor: t.vendor, token: t.token }));
    });

    const dbMock = {
        serviceAccountToken: {
            upsert,
            findUnique,
            delete: deleteOne,
            findMany,
        },
    };

    return { dbMock, resetState, state };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/utils/log", () => ({ log: vi.fn() }));
vi.mock("@/app/auth/auth", () => ({ auth: {} }));
vi.mock("@/app/github/githubConnect", () => ({ githubConnect: vi.fn() }));
vi.mock("@/app/github/githubDisconnect", () => ({ githubDisconnect: vi.fn() }));
vi.mock("@/context", () => ({ Context: { create: vi.fn() } }));
vi.mock("@/app/events/eventRouter", () => ({ eventRouter: { emitUpdate: vi.fn() } }));

import { connectRoutes } from "./connectRoutes";

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

    connectRoutes(typed);
    await typed.ready();
    return typed;
}

describe("connectRoutes — vendor token endpoints", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
    });

    afterEach(async () => {
        if (app) {
            await app.close();
        }
    });

    // ─── POST /v1/connect/:vendor/register ──────────────────────────────

    describe("POST /v1/connect/:vendor/register", () => {
        it("stores token blob as-is without modification", async () => {
            app = await createApp();
            const opaqueBlob = "AQIDBA==base64encryptedblob";

            const response = await app.inject({
                method: "POST",
                url: "/v1/connect/anthropic/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: opaqueBlob },
            });

            expect(response.statusCode).toBe(200);
            expect(state.tokens).toHaveLength(1);
            // Critical: the server must store exactly what the client sent
            expect(state.tokens[0].token).toBe(opaqueBlob);
            expect(state.tokens[0].vendor).toBe("anthropic");
            expect(state.tokens[0].accountId).toBe("user-1");
        });

        it("upsert overwrites on second POST", async () => {
            app = await createApp();

            await app.inject({
                method: "POST",
                url: "/v1/connect/openai/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: "blob-v1" },
            });

            await app.inject({
                method: "POST",
                url: "/v1/connect/openai/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: "blob-v2" },
            });

            expect(state.tokens).toHaveLength(1);
            expect(state.tokens[0].token).toBe("blob-v2");
        });

        it("stores independently per vendor", async () => {
            app = await createApp();

            await app.inject({
                method: "POST",
                url: "/v1/connect/openai/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: "openai-blob" },
            });

            await app.inject({
                method: "POST",
                url: "/v1/connect/anthropic/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: "anthropic-blob" },
            });

            expect(state.tokens).toHaveLength(2);
            expect(state.tokens.find((t) => t.vendor === "openai")?.token).toBe("openai-blob");
            expect(state.tokens.find((t) => t.vendor === "anthropic")?.token).toBe("anthropic-blob");
        });

        it("rejects without auth (401)", async () => {
            app = await createApp();

            const response = await app.inject({
                method: "POST",
                url: "/v1/connect/anthropic/register",
                payload: { token: "some-blob" },
            });

            expect(response.statusCode).toBe(401);
        });
    });

    // ─── GET /v1/connect/:vendor/token ──────────────────────────────────

    describe("GET /v1/connect/:vendor/token", () => {
        it("returns blob exactly as stored, no decryption", async () => {
            app = await createApp();
            const opaqueBlob = "AQIDBA==encrypted-token-data";

            // Store a token first
            await app.inject({
                method: "POST",
                url: "/v1/connect/anthropic/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: opaqueBlob },
            });

            const response = await app.inject({
                method: "GET",
                url: "/v1/connect/anthropic/token",
                headers: { "x-user-id": "user-1" },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            // Server returns exactly what was stored — no decryption
            expect(body.token).toBe(opaqueBlob);
        });

        it("returns { token: null } when no token exists", async () => {
            app = await createApp();

            const response = await app.inject({
                method: "GET",
                url: "/v1/connect/gemini/token",
                headers: { "x-user-id": "user-1" },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.token).toBeNull();
        });

        it("returns 401 without auth", async () => {
            app = await createApp();

            const response = await app.inject({
                method: "GET",
                url: "/v1/connect/anthropic/token",
            });

            expect(response.statusCode).toBe(401);
        });

        it("enforces ownership isolation (different user cannot read another's token)", async () => {
            app = await createApp();

            // user-1 stores a token
            await app.inject({
                method: "POST",
                url: "/v1/connect/anthropic/register",
                headers: { "x-user-id": "user-1" },
                payload: { token: "user1-secret-blob" },
            });

            // user-2 tries to read it — should get null (scoped by accountId)
            const response = await app.inject({
                method: "GET",
                url: "/v1/connect/anthropic/token",
                headers: { "x-user-id": "user-2" },
            });

            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.token).toBeNull();
        });
    });
});
