import { beforeEach, describe, expect, it, vi } from "vitest";

const {
    dbMock,
    encryptStringMock,
    decryptStringMock,
    resetMocks
} = vi.hoisted(() => {
    const dbMock = {
        serviceAccountToken: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            delete: vi.fn(),
            findMany: vi.fn()
        }
    };

    const encryptStringMock = vi.fn((path: string[], value: string) => `encrypted:${path.join("/")}:${value}`);
    const decryptStringMock = vi.fn((_: string[], value: string) => `decrypted:${value}`);

    const resetMocks = () => {
        dbMock.serviceAccountToken.upsert.mockReset();
        dbMock.serviceAccountToken.findUnique.mockReset();
        dbMock.serviceAccountToken.delete.mockReset();
        dbMock.serviceAccountToken.findMany.mockReset();
        encryptStringMock.mockClear();
        decryptStringMock.mockClear();
    };

    return {
        dbMock,
        encryptStringMock,
        decryptStringMock,
        resetMocks
    };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/modules/encrypt", () => ({
    encryptString: encryptStringMock,
    decryptString: decryptStringMock
}));

vi.mock("@/app/auth/auth", () => ({
    auth: {
        createGithubToken: vi.fn(),
        verifyGithubToken: vi.fn()
    }
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: {}
}));

vi.mock("@/app/github/githubConnect", () => ({
    githubConnect: vi.fn()
}));

vi.mock("@/app/github/githubDisconnect", () => ({
    githubDisconnect: vi.fn()
}));

vi.mock("@/context", () => ({
    Context: {
        create: vi.fn((userId: string) => ({ userId }))
    }
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

vi.mock("zod", () => {
    const createSchema = () => {
        const schema: any = {};
        schema.optional = () => schema;
        schema.nullable = () => schema;
        schema.passthrough = () => schema;
        schema.array = () => schema;
        schema.uuid = () => schema;
        schema.int = () => schema;
        schema.positive = () => schema;
        return schema;
    };

    const z = {
        object: () => createSchema(),
        string: () => createSchema(),
        enum: () => createSchema(),
        literal: () => createSchema(),
        boolean: () => createSchema(),
        any: () => createSchema(),
        array: () => createSchema(),
        number: () => createSchema(),
    };

    return { z };
});

import { connectRoutes } from "./connectRoutes";
import { __resetLongTaskStoreForTests } from "../longTaskStore";

type RouteHandler = (request: any, reply: any) => Promise<any>;

class FakeReply {
    statusCode = 200;
    payload: any;

    code(statusCode: number) {
        this.statusCode = statusCode;
        return this;
    }

    send(payload: any) {
        this.payload = payload;
        return payload;
    }

    redirect(url: string) {
        this.statusCode = 302;
        this.payload = { redirect: url };
        return this.payload;
    }
}

function createFakeApp() {
    const routes = new Map<string, RouteHandler>();

    const app = {
        authenticate: vi.fn(),
        addContentTypeParser: vi.fn(),
        get: vi.fn((path: string, _opts: any, handler: RouteHandler) => {
            routes.set(`GET ${path}`, handler);
        }),
        post: vi.fn((path: string, _opts: any, handler: RouteHandler) => {
            routes.set(`POST ${path}`, handler);
        }),
        delete: vi.fn((path: string, _opts: any, handler: RouteHandler) => {
            routes.set(`DELETE ${path}`, handler);
        }),
    };

    connectRoutes(app as any);

    const invoke = async (method: "GET" | "POST" | "DELETE", path: string, request: any) => {
        const handler = routes.get(`${method} ${path}`);
        if (!handler) {
            throw new Error(`Missing route for ${method} ${path}`);
        }
        const reply = new FakeReply();
        const result = await handler(request, reply);
        return {
            statusCode: reply.statusCode,
            payload: reply.payload ?? result
        };
    };

    return { invoke };
}

async function waitForTaskState(invoke: ReturnType<typeof createFakeApp>["invoke"], taskId: string, expectedState: string, userId = "user-1") {
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
        const response = await invoke("GET", "/v1/tasks/:taskId", {
            params: { taskId },
            userId
        });

        if (response.statusCode === 200 && response.payload.state === expectedState) {
            return response.payload;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for task ${taskId} to reach ${expectedState}`);
}

describe("connectRoutes", () => {
    beforeEach(() => {
        resetMocks();
        __resetLongTaskStoreForTests();
    });

    it("returns 202 and eventually succeeds for vendor token registration", async () => {
        dbMock.serviceAccountToken.upsert.mockResolvedValue({ ok: true });
        const { invoke } = createFakeApp();

        const accepted = await invoke("POST", "/v1/connect/:vendor/register", {
            userId: "user-1",
            params: { vendor: "openai" },
            body: { token: "{\"oauth\":true}" }
        });

        expect(accepted.statusCode).toBe(202);
        expect(accepted.payload.state).toBe("accepted");

        const succeeded = await waitForTaskState(invoke, accepted.payload.taskId, "succeeded");
        expect(succeeded.stage).toBe("succeeded");
        expect(dbMock.serviceAccountToken.upsert).toHaveBeenCalledTimes(1);
        expect(encryptStringMock).toHaveBeenCalledWith(
            ["user", "user-1", "vendors", "openai", "token"],
            "{\"oauth\":true}"
        );
    });

    it("refreshes heartbeat while persisting a long-running registration", async () => {
        dbMock.serviceAccountToken.upsert.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            return { ok: true };
        });
        const { invoke } = createFakeApp();

        const accepted = await invoke("POST", "/v1/connect/:vendor/register", {
            userId: "user-1",
            params: { vendor: "gemini" },
            body: { token: "{\"slow\":true}" }
        });

        await new Promise((resolve) => setTimeout(resolve, 150));
        const first = await invoke("GET", "/v1/tasks/:taskId", {
            params: { taskId: accepted.payload.taskId },
            userId: "user-1"
        });
        expect(first.payload.state).toBe("running");
        expect(first.payload.stage).toBe("persisting");

        await new Promise((resolve) => setTimeout(resolve, 900));
        const second = await invoke("GET", "/v1/tasks/:taskId", {
            params: { taskId: accepted.payload.taskId },
            userId: "user-1"
        });
        expect(second.payload.stage).toBe("persisting");
        expect(Date.parse(second.payload.heartbeatAt)).toBeGreaterThan(Date.parse(first.payload.heartbeatAt));

        const succeeded = await waitForTaskState(invoke, accepted.payload.taskId, "succeeded");
        expect(succeeded.state).toBe("succeeded");
    });

    it("surfaces task failure details", async () => {
        dbMock.serviceAccountToken.upsert.mockRejectedValue(new Error("database unavailable"));
        const { invoke } = createFakeApp();

        const accepted = await invoke("POST", "/v1/connect/:vendor/register", {
            userId: "user-1",
            params: { vendor: "anthropic" },
            body: { token: "{\"oauth\":true}" }
        });

        const failed = await waitForTaskState(invoke, accepted.payload.taskId, "failed");
        expect(failed.stage).toBe("failed");
        expect(failed.error).toBe("database unavailable");
    });

    it("keeps token lookup behavior intact", async () => {
        dbMock.serviceAccountToken.findUnique.mockResolvedValue({ token: "ciphertext" });
        const { invoke } = createFakeApp();

        const response = await invoke("GET", "/v1/connect/:vendor/token", {
            userId: "user-1",
            params: { vendor: "openai" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.payload).toEqual({ token: "decrypted:ciphertext" });
    });
});
