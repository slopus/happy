import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";
// Cross-package contract check: the app's real update schema. apiTypes.ts is
// pure zod (no react-native / @/ aliases), so it imports cleanly in node.
import { ApiUpdateContainerSchema } from "../../../../../happy-app/sources/sync/apiTypes";

const {
    state,
    dbMock,
    resetState,
    allocateUserSeqMock,
    emitUpdateSpy,
    emitEphemeralSpy,
    machineUpdate,
    machineUpdateMany,
    accessKeyMutationSpy,
    sessionMutationSpy,
    machineDeleteSpy,
    invalidateSessionFollowupsSpy,
    emitProjectAutomationUpdateSpy,
    logSpy,
} = vi.hoisted(() => {
    const emitUpdateSpy = vi.fn();
    const emitEphemeralSpy = vi.fn();
    const accessKeyMutationSpy = vi.fn();
    const sessionMutationSpy = vi.fn();
    const machineDeleteSpy = vi.fn(async () => {
        const deleted = state.existingMachine;
        state.existingMachine = null;
        return deleted;
    });
    const invalidateSessionFollowupsSpy = vi.fn(async (): Promise<any[]> => []);
    const emitProjectAutomationUpdateSpy = vi.fn(async () => undefined);
    const logSpy = vi.fn();
    const state = {
        existingMachine: null as any,
        created: [] as any[],
        seq: 0,
    };

    const resetState = () => {
        state.existingMachine = null;
        state.created = [];
        state.seq = 0;
    };

    const machineFindFirst = vi.fn(async (args?: any) => {
        const machine = state.existingMachine;
        if (!machine) return null;
        const where = args?.where ?? {};
        if (where.id !== undefined && machine.id !== where.id) return null;
        if (where.accountId !== undefined && machine.accountId !== where.accountId) return null;
        return machine;
    });
    const machineCreate = vi.fn(async (args: any) => {
        // Mirror a Prisma Machine row: server defaults active=false on create
        // ("Default to offline - in case the user does not start daemon").
        const now = new Date("2026-01-01T00:00:00.000Z");
        const row = {
            id: args.data.id,
            accountId: args.data.accountId,
            seq: 7,
            metadata: args.data.metadata,
            metadataVersion: args.data.metadataVersion ?? 1,
            daemonState: args.data.daemonState ?? null,
            daemonStateVersion: args.data.daemonStateVersion ?? 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            serverDataEncryptionKey: args.data.serverDataEncryptionKey ?? null,
            serverRpcKeyEnvelope: args.data.serverRpcKeyEnvelope ?? null,
            active: false,
            lastActiveAt: now,
            createdAt: now,
            updatedAt: now,
        };
        state.created.push(row);
        return row;
    });

    const machineUpdate = vi.fn(async (args: any) => {
        state.existingMachine = { ...state.existingMachine, ...args.data };
        return state.existingMachine;
    });
    const machineUpdateMany = vi.fn(async (args: any) => {
        const machine = state.existingMachine;
        const expected = args.where.dataEncryptionKey;
        const matchesExpected = machine?.dataEncryptionKey instanceof Uint8Array
            && expected instanceof Uint8Array
            && Buffer.from(machine.dataEncryptionKey).equals(Buffer.from(expected));
        if (!machine || machine.id !== args.where.id || machine.accountId !== args.where.accountId || !matchesExpected) {
            return { count: 0 };
        }
        // Version guards (key rotation): every other scalar in where must match.
        for (const field of ['metadataVersion', 'daemonStateVersion'] as const) {
            if (args.where[field] !== undefined && machine[field] !== args.where[field]) return { count: 0 };
        }
        state.existingMachine = { ...machine, ...args.data };
        return { count: 1 };
    });
    const machineFindMany = vi.fn(async (): Promise<any[]> => []);
    const dbMock = {
        machine: { findFirst: machineFindFirst, create: machineCreate, update: machineUpdate, updateMany: machineUpdateMany, findMany: machineFindMany, delete: machineDeleteSpy },
        accessKey: { updateMany: accessKeyMutationSpy, deleteMany: accessKeyMutationSpy },
        session: { updateMany: sessionMutationSpy, deleteMany: sessionMutationSpy },
    };
    const allocateUserSeqMock = vi.fn(async () => ++state.seq);

    return {
        state,
        dbMock,
        resetState,
        allocateUserSeqMock,
        emitUpdateSpy,
        emitEphemeralSpy,
        machineUpdate,
        machineUpdateMany,
        accessKeyMutationSpy,
        sessionMutationSpy,
        machineDeleteSpy,
        invalidateSessionFollowupsSpy,
        emitProjectAutomationUpdateSpy,
        logSpy,
    };
});

// Keep the REAL event-builder functions (buildNewMachineUpdate etc.), but
// replace the eventRouter singleton with a spy so we can capture exactly what
// the create handler emits.
vi.mock("@/app/events/eventRouter", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/events/eventRouter")>();
    return { ...actual, eventRouter: { emitUpdate: emitUpdateSpy, emitEphemeral: emitEphemeralSpy } };
});
vi.mock("@/storage/db", () => ({ db: dbMock }));
const { authorizeManagedDaemonSpy } = vi.hoisted(() => ({ authorizeManagedDaemonSpy: vi.fn() }));
vi.mock("@/app/managed/managedDaemonAccess", () => ({ authorizeManagedDaemonRequest: authorizeManagedDaemonSpy }));
vi.mock("@/storage/seq", () => ({ allocateUserSeq: allocateUserSeqMock }));
vi.mock("@/storage/inTx", () => ({ inTx: async (fn: any) => fn(dbMock), afterTx: (_tx: any, cb: () => void) => cb() }));
vi.mock("@/app/automation/sessionFollowupInvalidationService", () => ({
    invalidateSessionFollowups: invalidateSessionFollowupsSpy,
}));
vi.mock("@/app/automation/automationUpdate", () => ({
    emitProjectAutomationUpdate: emitProjectAutomationUpdateSpy,
}));
vi.mock("@/utils/log", () => ({ log: logSpy, warn: vi.fn(), error: vi.fn() }));

import { machinesRoutes } from "./machinesRoutes";
import { enableErrorHandlers } from "../utils/enableErrorHandlers";

async function createApp({ withErrorHandlers = false, managedControl = null }: {
    withErrorHandlers?: boolean;
    managedControl?: { daemonTokens: unknown } | null;
} = {}) {
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
    if (withErrorHandlers) {
        enableErrorHandlers(typed, { skipNotFoundHandler: true });
    }
    machinesRoutes(typed, () => managedControl as never);
    await typed.ready();
    return typed;
}

function findEmit(t: string) {
    return emitUpdateSpy.mock.calls.find(([p]) => p?.payload?.body?.t === t)?.[0];
}

describe("machinesRoutes — POST /v1/machines creation emits", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    it("emits new-machine to the user's app AND a key-less update-machine companion", async () => {
        app = await createApp();

        const res = await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-1",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });
        expect(res.statusCode).toBe(200);

        const newMachine = findEmit("new-machine");
        const updateMachine = findEmit("update-machine");

        // Both updates are emitted on creation.
        expect(newMachine).toBeDefined();
        expect(updateMachine).toBeDefined();

        // new-machine is the signal the user's app gets to LEARN about the
        // machine, and it carries the per-machine data encryption key.
        expect(newMachine.recipientFilter).toEqual({ type: "user-scoped-only" });
        expect(newMachine.payload.body.dataEncryptionKey).toBeTruthy();

        // The update-machine companion ALSO reaches the app (machine-scoped-only
        // resolves to a union that includes the user-scoped room), but it carries
        // NO data encryption key — so pre-fix the app could not initialize this
        // brand-new machine's encryption from it and dropped it at the
        // getMachineEncryption() guard. That's why new-machine handling is required.
        expect(updateMachine.recipientFilter).toEqual({ type: "machine-scoped-only", machineId: "machine-1" });
        expect(updateMachine.payload.body).not.toHaveProperty("dataEncryptionKey");
    });

    it("emits a new-machine update that validates against the app's update schema (the fix accepts the real payload)", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: {
                id: "machine-2",
                metadata: "encrypted-metadata-blob",
                dataEncryptionKey: Buffer.from("the-data-key").toString("base64"),
            },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();

        // The exact container the server pushes over the 'update' socket event —
        // this is what Sync.handleUpdate runs ApiUpdateContainerSchema.safeParse()
        // on. Pre-fix it failed (no new-machine member) and the machine was
        // dropped; post-fix it must validate.
        const parsed = ApiUpdateContainerSchema.safeParse(newMachine.payload);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.body.t).toBe("new-machine");
        }
    });

    it("emits a new-machine update that also validates when there is no data encryption key", async () => {
        app = await createApp();

        await app.inject({
            method: "POST",
            url: "/v1/machines",
            headers: { "x-user-id": "user-1" },
            payload: { id: "machine-3", metadata: "encrypted-metadata-blob" },
        });

        const newMachine = findEmit("new-machine");
        expect(newMachine).toBeDefined();
        expect(newMachine.payload.body.dataEncryptionKey).toBeNull();
        expect(ApiUpdateContainerSchema.safeParse(newMachine.payload).success).toBe(true);
    });
});

// aplus §6-1 Phase 3c (aplus-dev-studio specs/20260818-e2ee-account-keypair) —
// dataEncryptionKey write-once 백필. 기존 머신은 create 시점에만 키를 저장할
// 수 있었는데, aplus claim 흐름은 legacy(secret) 모드로 먼저 등록하고 신버전
// daemon 이 나중에 wrap 된 machineKey 를 제출한다. null 일 때만 채우고,
// non-null 덮어쓰기는 금지한다 (키 교체 공격·고아 암호문 방지 — 회전은 별도
// 명시 흐름의 몫).
describe("machinesRoutes — POST /v1/machines dataEncryptionKey write-once backfill", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); machineUpdate.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const existingRow = (dataEncryptionKey: Uint8Array | null) => ({
        id: "machine-1",
        accountId: "user-1",
        seq: 7,
        metadata: "encrypted-metadata-blob",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey,
        active: false,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
    });

    const post = (payload: Record<string, unknown>) => app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { "x-user-id": "user-1" },
        payload: { id: "machine-1", metadata: "encrypted-metadata-blob", ...payload },
    });

    it("backfills a null dataEncryptionKey from a late submission and echoes it", async () => {
        app = await createApp();
        state.existingMachine = existingRow(null);
        const wrapped = Buffer.from("wrapped-machine-key").toString("base64");

        const res = await post({ dataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).toHaveBeenCalledTimes(1);
        const updateArg = machineUpdate.mock.calls[0][0];
        expect(updateArg.where).toEqual({ id: "machine-1" });
        expect(Buffer.from(updateArg.data.dataEncryptionKey).toString("base64")).toBe(wrapped);
        expect(res.json().machine.dataEncryptionKey).toBe(wrapped);
    });

    it("never overwrites an existing dataEncryptionKey (write-once)", async () => {
        app = await createApp();
        const original = new Uint8Array(Buffer.from("original-key"));
        state.existingMachine = existingRow(original);

        const res = await post({ dataEncryptionKey: Buffer.from("attacker-key").toString("base64") });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.dataEncryptionKey).toBe(Buffer.from("original-key").toString("base64"));
    });

    it("does nothing when an existing machine re-registers without the field (old CLI)", async () => {
        app = await createApp();
        state.existingMachine = existingRow(null);

        const res = await post({});

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.dataEncryptionKey).toBeNull();
    });
});

describe("machinesRoutes — PATCH /v1/machines/:id/data-encryption-key CAS", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        machineUpdateMany.mockClear();
        accessKeyMutationSpy.mockClear();
        sessionMutationSpy.mockClear();
        logSpy.mockClear();
    });
    afterEach(async () => { if (app) await app.close(); });

    const envelope = (fill: number) => {
        const bytes = new Uint8Array(105).fill(fill);
        bytes[0] = 0;
        return Buffer.from(bytes).toString("base64");
    };

    it("replaces the authenticated account's matching dataEncryptionKey", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(expectedDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: true });
        expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(replacementDataEncryptionKey);
    });

    it("treats the same replacement as an idempotent success", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: false });
        expect(machineUpdateMany).toHaveBeenCalledTimes(1);
    });

    it("does not write when expected and replacement envelopes are identical", async () => {
        app = await createApp();
        const dataEncryptionKey = envelope(1);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(dataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: dataEncryptionKey,
                replacementDataEncryptionKey: dataEncryptionKey,
            },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: false });
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("still enforces account ownership for identical envelopes", async () => {
        app = await createApp();
        const dataEncryptionKey = envelope(1);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-2",
            dataEncryptionKey: new Uint8Array(Buffer.from(dataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: dataEncryptionKey,
                replacementDataEncryptionKey: dataEncryptionKey,
            },
        });

        expect(res.statusCode).toBe(404);
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("rejects a stale expected envelope without changing the machine", async () => {
        app = await createApp();
        const currentDataEncryptionKey = envelope(3);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(currentDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: envelope(1),
                replacementDataEncryptionKey: envelope(2),
            },
        });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ error: "data-encryption-key-conflict" });
        expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(currentDataEncryptionKey);
    });

    it.each([
        ["owned by another account", "user-2"],
        ["absent", null],
    ])("returns 404 when the machine is %s", async (_case, accountId) => {
        app = await createApp();
        const originalDataEncryptionKey = envelope(1);
        state.existingMachine = accountId ? {
            id: "machine-1",
            accountId,
            dataEncryptionKey: new Uint8Array(Buffer.from(originalDataEncryptionKey, "base64")),
        } : null;

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: originalDataEncryptionKey,
                replacementDataEncryptionKey: envelope(2),
            },
        });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: "Machine not found" });
        if (state.existingMachine) {
            expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(originalDataEncryptionKey);
        }
    });

    it("rejects malformed base64 without writing it", async () => {
        app = await createApp();
        const originalDataEncryptionKey = envelope(1);
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(originalDataEncryptionKey, "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey: originalDataEncryptionKey,
                replacementDataEncryptionKey: "!!!not-base64!!!",
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "invalid-data-encryption-key-envelope" });
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it.each([
        ["wrong-length expected envelope", Buffer.from(new Uint8Array(104)).toString("base64"), envelope(2)],
        ["unsupported-version replacement envelope", envelope(1), Buffer.from(new Uint8Array(105).fill(1)).toString("base64")],
        ["oversized replacement envelope", envelope(1), "A".repeat(141)],
    ])("rejects a %s", async (_case, expectedDataEncryptionKey, replacementDataEncryptionKey) => {
        app = await createApp();
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
            dataEncryptionKey: new Uint8Array(Buffer.from(envelope(1), "base64")),
        };

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(400);
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("does not expose an oversized envelope through validation errors or logs", async () => {
        app = await createApp({ withErrorHandlers: true });
        const expectedDataEncryptionKey = envelope(1);
        const oversizedEnvelope = `sensitive-envelope-${"A".repeat(141)}`;

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: {
                expectedDataEncryptionKey,
                replacementDataEncryptionKey: oversizedEnvelope,
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.body).not.toContain("sensitive-envelope");
        expect(JSON.stringify(logSpy.mock.calls)).not.toContain("sensitive-envelope");
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("changes only dataEncryptionKey and does not expose either envelope", async () => {
        app = await createApp();
        const expectedDataEncryptionKey = envelope(1);
        const replacementDataEncryptionKey = envelope(2);
        const original = {
            id: "machine-1",
            accountId: "user-1",
            seq: 17,
            metadata: "encrypted-metadata",
            metadataVersion: 4,
            daemonState: "encrypted-daemon-state",
            daemonStateVersion: 6,
            dataEncryptionKey: new Uint8Array(Buffer.from(expectedDataEncryptionKey, "base64")),
            serverDataEncryptionKey: new Uint8Array(Buffer.from(envelope(3), "base64")),
            active: true,
            lastActiveAt: new Date("2026-08-27T00:00:00.000Z"),
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
            updatedAt: new Date("2026-08-26T00:00:00.000Z"),
        };
        state.existingMachine = original;

        const res = await app.inject({
            method: "PATCH",
            url: "/v1/machines/machine-1/data-encryption-key",
            headers: { "x-user-id": "user-1" },
            payload: { expectedDataEncryptionKey, replacementDataEncryptionKey },
        });

        expect(res.statusCode).toBe(200);
        expect(machineUpdateMany.mock.calls[0][0].data).toEqual({
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
        });
        expect(state.existingMachine).toMatchObject({
            id: original.id,
            accountId: original.accountId,
            seq: original.seq,
            metadata: original.metadata,
            metadataVersion: original.metadataVersion,
            daemonState: original.daemonState,
            daemonStateVersion: original.daemonStateVersion,
            dataEncryptionKey: new Uint8Array(Buffer.from(replacementDataEncryptionKey, "base64")),
            serverDataEncryptionKey: original.serverDataEncryptionKey,
            active: original.active,
            lastActiveAt: original.lastActiveAt,
            createdAt: original.createdAt,
        });
        expect(accessKeyMutationSpy).not.toHaveBeenCalled();
        expect(sessionMutationSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
        expect(res.body).not.toContain(expectedDataEncryptionKey);
        expect(res.body).not.toContain(replacementDataEncryptionKey);
    });
});

describe("machinesRoutes — serverDataEncryptionKey dual-recipient wrap (aplus §6-1 B1)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); emitEphemeralSpy.mockClear(); machineUpdate.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const existingRow = (overrides: Record<string, unknown> = {}) => ({
        id: "machine-1",
        accountId: "user-1",
        seq: 7,
        metadata: "encrypted-metadata-blob",
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        serverDataEncryptionKey: null,
        active: false,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    });

    const post = (payload: Record<string, unknown>) => app.inject({
        method: "POST",
        url: "/v1/machines",
        headers: { "x-user-id": "user-1" },
        payload: { id: "machine-1", metadata: "encrypted-metadata-blob", ...payload },
    });

    it("stores serverDataEncryptionKey on creation and echoes it", async () => {
        app = await createApp();
        const wrapped = Buffer.from("server-wrapped-machine-key").toString("base64");

        const res = await post({ serverDataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(res.json().machine.serverDataEncryptionKey).toBe(wrapped);
        expect(Buffer.from(state.created[0].serverDataEncryptionKey).toString("base64")).toBe(wrapped);
    });

    it("backfills a null serverDataEncryptionKey from a late submission and echoes it", async () => {
        app = await createApp();
        state.existingMachine = existingRow({ dataEncryptionKey: new Uint8Array(Buffer.from("acct-key")) });
        const wrapped = Buffer.from("server-wrapped-machine-key").toString("base64");

        const res = await post({ serverDataEncryptionKey: wrapped });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).toHaveBeenCalledTimes(1);
        const updateArg = machineUpdate.mock.calls[0][0];
        expect(Buffer.from(updateArg.data.serverDataEncryptionKey).toString("base64")).toBe(wrapped);
        // 계정 몫 봉투는 건드리지 않는다.
        expect(updateArg.data).not.toHaveProperty("dataEncryptionKey");
        expect(res.json().machine.serverDataEncryptionKey).toBe(wrapped);
    });

    it("never overwrites an existing serverDataEncryptionKey (write-once)", async () => {
        app = await createApp();
        state.existingMachine = existingRow({ serverDataEncryptionKey: new Uint8Array(Buffer.from("original-server-key")) });

        const res = await post({ serverDataEncryptionKey: Buffer.from("attacker-key").toString("base64") });

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.serverDataEncryptionKey).toBe(Buffer.from("original-server-key").toString("base64"));
    });

    it("re-register without the field leaves it null (old CLI)", async () => {
        app = await createApp();
        state.existingMachine = existingRow();

        const res = await post({});

        expect(res.statusCode).toBe(200);
        expect(machineUpdate).not.toHaveBeenCalled();
        expect(res.json().machine.serverDataEncryptionKey).toBeNull();
    });

    it("GET /v1/machines includes serverDataEncryptionKey", async () => {
        app = await createApp();
        const wrapped = new Uint8Array(Buffer.from("server-wrapped-machine-key"));
        dbMock.machine.findMany.mockResolvedValue([existingRow({ serverDataEncryptionKey: wrapped })]);

        const res = await app.inject({ method: "GET", url: "/v1/machines", headers: { "x-user-id": "user-1" } });

        expect(res.statusCode).toBe(200);
        expect(res.json()[0].serverDataEncryptionKey).toBe(Buffer.from(wrapped).toString("base64"));
    });
});

describe("machinesRoutes — DELETE /v1/machines/:id follow-up fence", () => {
    let app: Fastify;
    beforeEach(() => {
        resetState();
        machineDeleteSpy.mockClear();
        invalidateSessionFollowupsSpy.mockClear();
        emitProjectAutomationUpdateSpy.mockClear();
        accessKeyMutationSpy.mockClear();
        emitUpdateSpy.mockClear();
    });
    afterEach(async () => { if (app) await app.close(); });

    it("invalidates active session follow-ups before deleting an owned machine", async () => {
        app = await createApp();
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-1",
        };
        invalidateSessionFollowupsSpy.mockResolvedValue([
            { id: "followup-1", projectId: "project-1" },
            { id: "followup-2", projectId: "project-1" },
        ]);

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });

        expect(res.statusCode).toBe(200);
        expect(invalidateSessionFollowupsSpy).toHaveBeenCalledWith(
            dbMock,
            { machineAccountId: "user-1", machineId: "machine-1" },
            "TARGET_MISMATCH",
        );
        expect(machineDeleteSpy).toHaveBeenCalledWith({ where: { id: "machine-1" } });
        expect(accessKeyMutationSpy).toHaveBeenCalledWith({
            where: { accountId: "user-1", machineId: "machine-1" },
        });
        expect(emitProjectAutomationUpdateSpy).toHaveBeenCalledTimes(1);
        expect(emitProjectAutomationUpdateSpy).toHaveBeenCalledWith(
            "project-1",
            { projectId: "project-1", reason: "sync" },
            "user-1",
        );
    });

    it("does not invalidate or delete another account's machine", async () => {
        app = await createApp();
        state.existingMachine = {
            id: "machine-1",
            accountId: "user-2",
        };

        const res = await app.inject({
            method: "DELETE",
            url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });

        expect(res.statusCode).toBe(404);
        expect(invalidateSessionFollowupsSpy).not.toHaveBeenCalled();
        expect(machineDeleteSpy).not.toHaveBeenCalled();
    });
});

// The one HTTP read a managed daemon makes about itself at start
// (`attachRegisteredMachine`). Its credential is not an account bearer — the
// daemon never holds one — so `authenticate` alone refused every managed
// runtime at boot with "Invalid token".
describe("machinesRoutes — GET /v1/machines/:id with the daemon's own credential", () => {
    let app: Fastify;
    const runtime = { daemonTokens: { verify: vi.fn() } };
    const claims = (over: Record<string, unknown> = {}) => ({
        v: 1, accountId: "user-1", machineId: "machine-1", runtimeId: "rt-1",
        provisioningOperationId: "op-1", daemonGrantId: "grant-1", generation: 0,
        workspaceId: "ws-1", projectId: "project-1", ...over,
    });
    beforeEach(() => {
        resetState();
        authorizeManagedDaemonSpy.mockReset();
        state.existingMachine = {
            id: "machine-1", accountId: "user-1", seq: 1, metadata: "m", metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null, serverDataEncryptionKey: null,
            active: false, lastActiveAt: new Date(0), createdAt: new Date(0), updatedAt: new Date(0),
        };
    });
    afterEach(async () => { if (app) await app.close(); });

    it("answers the machine to its own daemon credential", async () => {
        authorizeManagedDaemonSpy.mockResolvedValue({ ok: true, principal: { kind: "managed-daemon", claims: claims() } });
        app = await createApp({ managedControl: runtime });
        const res = await app.inject({
            method: "GET", url: "/v1/machines/machine-1",
            headers: { authorization: "Bearer daemon-token" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().machine.id).toBe("machine-1");
        // Verified as this machine's credential, against the issuer the server holds.
        expect(authorizeManagedDaemonSpy).toHaveBeenCalledWith(expect.objectContaining({
            token: "daemon-token", machineId: "machine-1", issuer: runtime.daemonTokens,
        }));
    });

    it("refuses a daemon credential that names another machine", async () => {
        authorizeManagedDaemonSpy.mockResolvedValue({ ok: false, reason: "machine-mismatch" });
        app = await createApp({ managedControl: runtime });
        const res = await app.inject({
            method: "GET", url: "/v1/machines/machine-1",
            headers: { authorization: "Bearer daemon-token" },
        });
        expect(res.statusCode).toBe(401);
    });

    it("does not consult the daemon issuer when the account bearer already authenticated", async () => {
        app = await createApp({ managedControl: runtime });
        const res = await app.inject({
            method: "GET", url: "/v1/machines/machine-1",
            headers: { "x-user-id": "user-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(authorizeManagedDaemonSpy).not.toHaveBeenCalled();
    });

    it("keeps refusing without a managed control runtime", async () => {
        app = await createApp();
        const res = await app.inject({
            method: "GET", url: "/v1/machines/machine-1",
            headers: { authorization: "Bearer daemon-token" },
        });
        expect(res.statusCode).toBe(401);
        expect(authorizeManagedDaemonSpy).not.toHaveBeenCalled();
    });
});


// aplus-dev-studio specs/e2ee-machine-control-boundary R1 — the server gets its
// own RPC key, not the machine key: a separate 105-byte envelope column, kept
// write-once like the others.
const envelope = (fill: number) => Buffer.concat([Buffer.from([0]), Buffer.alloc(104, fill)]).toString("base64");

describe("machinesRoutes — serverRpcKeyEnvelope (e2ee-machine-control-boundary R1)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); machineUpdate.mockClear(); machineUpdateMany.mockClear(); logSpy.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const existingRow = (overrides: Record<string, unknown> = {}) => ({
        id: "machine-1", accountId: "user-1", seq: 7, metadata: "m", metadataVersion: 1,
        daemonState: null, daemonStateVersion: 0, dataEncryptionKey: null, serverDataEncryptionKey: null,
        serverRpcKeyEnvelope: null, active: false, lastActiveAt: now, createdAt: now, updatedAt: now,
        ...overrides,
    });
    const post = (payload: Record<string, unknown>) => app.inject({
        method: "POST", url: "/v1/machines", headers: { "x-user-id": "user-1" },
        payload: { id: "machine-1", metadata: "m", ...payload },
    });

    it("stores the server lane envelope on creation and echoes it", async () => {
        app = await createApp();
        const res = await post({ serverRpcKeyEnvelope: envelope(1) });
        expect(res.statusCode).toBe(200);
        expect(res.json().machine.serverRpcKeyEnvelope).toBe(envelope(1));
        expect(Buffer.from(state.created[0].serverRpcKeyEnvelope).toString("base64")).toBe(envelope(1));
    });

    it("rejects a malformed server lane envelope and creates nothing", async () => {
        app = await createApp();
        const res = await post({ serverRpcKeyEnvelope: Buffer.from("not-an-envelope").toString("base64") });
        expect(res.statusCode).toBe(400);
        expect(state.created).toHaveLength(0);
    });

    it("backfills a missing server lane envelope once and never overwrites it", async () => {
        app = await createApp();
        state.existingMachine = existingRow();
        const first = await post({ serverRpcKeyEnvelope: envelope(2) });
        expect(first.json().machine.serverRpcKeyEnvelope).toBe(envelope(2));

        const second = await post({ serverRpcKeyEnvelope: envelope(3) });
        expect(second.json().machine.serverRpcKeyEnvelope).toBe(envelope(2));
        expect(machineUpdate).toHaveBeenCalledTimes(1);
    });

    it("returns the server lane envelope from both machine reads", async () => {
        app = await createApp();
        const row = existingRow({ serverRpcKeyEnvelope: new Uint8Array(Buffer.from(envelope(4), "base64")) });
        dbMock.machine.findMany.mockResolvedValue([row]);
        state.existingMachine = row;

        const list = await app.inject({ method: "GET", url: "/v1/machines", headers: { "x-user-id": "user-1" } });
        const one = await app.inject({ method: "GET", url: "/v1/machines/machine-1", headers: { "x-user-id": "user-1" } });

        expect(list.json()[0].serverRpcKeyEnvelope).toBe(envelope(4));
        expect(one.json().machine.serverRpcKeyEnvelope).toBe(envelope(4));
    });
});

// aplus-dev-studio specs/e2ee-machine-control-boundary R4 — strict mode takes
// the machine key back from the server: a new machine key and server lane key
// replace the account envelope and the server lane envelope, the machine key's
// server envelope is cleared, and the state re-encrypted under the new key
// lands in the same compare-and-swap.
describe("machinesRoutes — POST /v1/machines/:id/key-rotation (e2ee-machine-control-boundary R4)", () => {
    let app: Fastify;
    beforeEach(() => { resetState(); emitUpdateSpy.mockClear(); machineUpdate.mockClear(); machineUpdateMany.mockClear(); logSpy.mockClear(); });
    afterEach(async () => { if (app) await app.close(); });

    const now = new Date("2026-01-01T00:00:00.000Z");
    const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
    const escrowed = () => ({
        id: "machine-1", accountId: "user-1", seq: 7, metadata: "old-metadata", metadataVersion: 5,
        daemonState: "old-state", daemonStateVersion: 9,
        dataEncryptionKey: bytes(envelope(10)), serverDataEncryptionKey: bytes(envelope(11)),
        serverRpcKeyEnvelope: null, active: true, lastActiveAt: now, createdAt: now, updatedAt: now,
    });
    const rotate = (payload: Record<string, unknown>, userId = "user-1") => app.inject({
        method: "POST", url: "/v1/machines/machine-1/key-rotation", headers: { "x-user-id": userId },
        payload: {
            expectedDataEncryptionKey: envelope(10),
            dataEncryptionKey: envelope(20),
            serverRpcKeyEnvelope: envelope(21),
            metadata: "new-metadata",
            expectedMetadataVersion: 5,
            daemonState: "new-state",
            ...payload,
        },
    });

    it("swaps both envelopes, clears the escrowed machine key and stores the re-encrypted state", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const res = await rotate({});

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, changed: true, metadataVersion: 6, daemonStateVersion: 10 });
        const row = state.existingMachine;
        expect(Buffer.from(row.dataEncryptionKey).toString("base64")).toBe(envelope(20));
        expect(Buffer.from(row.serverRpcKeyEnvelope).toString("base64")).toBe(envelope(21));
        expect(row.serverDataEncryptionKey).toBeNull();
        expect(row).toMatchObject({ metadata: "new-metadata", metadataVersion: 6, daemonState: "new-state", daemonStateVersion: 10 });
    });

    it("accepts a rotation that gives the server no lane at all", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const res = await rotate({ serverRpcKeyEnvelope: null });

        expect(res.statusCode).toBe(200);
        expect(state.existingMachine.serverRpcKeyEnvelope).toBeNull();
        expect(state.existingMachine.serverDataEncryptionKey).toBeNull();
    });

    it("treats a retry of the same rotation as an idempotent success", async () => {
        app = await createApp();
        state.existingMachine = escrowed();
        await rotate({});

        const retry = await rotate({});

        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toMatchObject({ ok: true, changed: false });
        expect(state.existingMachine.metadataVersion).toBe(6);
    });

    it("refuses a stale expected envelope or metadata version without writing", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const staleKey = await rotate({ expectedDataEncryptionKey: envelope(12) });
        const staleVersion = await rotate({ expectedMetadataVersion: 4 });

        expect(staleKey.statusCode).toBe(409);
        expect(staleVersion.statusCode).toBe(409);
        expect(Buffer.from(state.existingMachine.dataEncryptionKey).toString("base64")).toBe(envelope(10));
        expect(state.existingMachine.serverDataEncryptionKey).not.toBeNull();
    });

    it("does not reach another account's machine", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const res = await rotate({}, "user-2");

        expect(res.statusCode).toBe(404);
        expect(state.existingMachine.serverDataEncryptionKey).not.toBeNull();
    });

    it("rejects malformed envelopes", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const res = await rotate({ dataEncryptionKey: Buffer.from("short").toString("base64") });

        expect(res.statusCode).toBe(400);
        expect(machineUpdateMany).not.toHaveBeenCalled();
    });

    it("announces the new machine state and never puts an envelope in a log line or the reply", async () => {
        app = await createApp();
        state.existingMachine = escrowed();

        const res = await rotate({});

        const update = emitUpdateSpy.mock.calls.map(([arg]: any[]) => arg.payload.body).find((body: any) => body.t === "update-machine");
        expect(update).toMatchObject({ machineId: "machine-1", metadata: { value: "new-metadata", version: 6 }, daemonState: { value: "new-state", version: 10 } });
        const logged = JSON.stringify(logSpy.mock.calls);
        for (const value of [envelope(10), envelope(20), envelope(21)]) {
            expect(logged).not.toContain(value);
            expect(res.body).not.toContain(value);
        }
    });
});
