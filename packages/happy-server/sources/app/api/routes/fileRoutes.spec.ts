import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    filesMock,
    fsMock,
    resetState,
} = vi.hoisted(() => {
    const state = {
        useLocalStorage: false,
        s3GetUrl: "https://s3.test/presigned",
        localFiles: new Map<string, Buffer>(),
    };

    const resetState = () => {
        state.useLocalStorage = false;
        state.s3GetUrl = "https://s3.test/presigned";
        state.localFiles = new Map();
    };

    const filesMock = {
        s3client: {
            presignedGetObject: vi.fn(async (_bucket: string, _key: string, _ttl: number) => state.s3GetUrl),
        },
        s3bucket: "test-bucket",
        isPublicFilePath: vi.fn((filePath: string) => filePath === "public" || filePath.startsWith("public/")),
        isLocalStorage: vi.fn(() => state.useLocalStorage),
        getLocalFilesDir: vi.fn(() => "/tmp/test-files"),
    };

    const fsMock = {
        existsSync: vi.fn((p: string) => {
            const rel = p.replace(/^\/tmp\/test-files\//, "");
            return state.localFiles.has(rel);
        }),
        createReadStream: vi.fn((p: string) => {
            const { Readable } = require("stream");
            const rel = p.replace(/^\/tmp\/test-files\//, "");
            return Readable.from(state.localFiles.get(rel) ?? Buffer.alloc(0));
        }),
    };

    return { state, filesMock, fsMock, resetState };
});

vi.mock("@/storage/files", () => filesMock);
vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return { ...actual, existsSync: fsMock.existsSync, createReadStream: fsMock.createReadStream };
});

import { fileRoutes, isReservedSessionSharePath } from "./fileRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    fileRoutes(typed);
    await typed.ready();
    return typed;
}

describe("fileRoutes", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); });
    afterEach(async () => { if (app) await app.close(); });

    it("redirects public S3 files to a presigned GET URL", async () => {
        state.useLocalStorage = false;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/files/public/users/u1/avatars/avatar.jpg",
        });

        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe("https://s3.test/presigned");
        expect(filesMock.s3client.presignedGetObject).toHaveBeenCalledWith(
            "test-bucket",
            "public/users/u1/avatars/avatar.jpg",
            expect.any(Number),
        );
    });

    it("does not expose non-public S3 objects through /files", async () => {
        state.useLocalStorage = false;
        app = await createApp();

        const res = await app.inject({
            method: "GET",
            url: "/files/sessions/s1/attachments/a.enc",
        });

        expect(res.statusCode).toBe(404);
    });

    it("blocks current and legacy share prefixes before local or S3 lookup", async () => {
        expect(isReservedSessionSharePath("private/session-shares/share/draft/asset")).toBe(true);
        expect(isReservedSessionSharePath("public/session-shares/share/draft/asset")).toBe(true);
        expect(isReservedSessionSharePath("public/avatars/avatar.png")).toBe(false);

        state.useLocalStorage = true;
        state.localFiles.set("private/session-shares/share/draft/asset", Buffer.from("private"));
        app = await createApp();
        expect((await app.inject({ method: "GET", url: "/files/private/session-shares/share/draft/asset" })).statusCode).toBe(403);
        await app.close();

        state.useLocalStorage = false;
        app = await createApp();
        expect((await app.inject({ method: "GET", url: "/files/public/session-shares/share/draft/asset" })).statusCode).toBe(403);
        expect(filesMock.s3client.presignedGetObject).not.toHaveBeenCalledWith(
            "test-bucket",
            "public/session-shares/share/draft/asset",
            expect.any(Number),
        );
    });
});
