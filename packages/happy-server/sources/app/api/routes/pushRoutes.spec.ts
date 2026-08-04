import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

const {
    state,
    dbMock,
    pushSendMock,
    resetState
} = vi.hoisted(() => {
    const state = {
        sessions: [] as Array<{ id: string; accountId: string }>,
        tokens: [] as Array<{ id: string; token: string }>,
        // Sockets the presence check sees, as socket.data shapes.
        sockets: [] as Array<{ data: Record<string, unknown> }>,
        sent: [] as Array<{ to: string; title?: string }>,
        ticketOverride: null as null | Array<{ status: 'ok' | 'error'; message?: string; details?: { error?: string } }>,
        presenceError: null as string | null,
    };

    const resetState = () => {
        state.sessions = [];
        state.tokens = [];
        state.sockets = [];
        state.sent = [];
        state.ticketOverride = null;
        state.presenceError = null;
    };

    const dbMock = {
        session: {
            findFirst: vi.fn(async ({ where }: any) =>
                state.sessions.find(s => s.id === where.id && s.accountId === where.accountId) ?? null)
        },
        accountPushToken: {
            findMany: vi.fn(async () => state.tokens),
            deleteMany: vi.fn(async () => ({ count: 0 }))
        }
    };

    const pushSendMock = vi.fn(async (messages: Array<{ to: string; title?: string }>) => {
        state.sent.push(...messages);
        return state.ticketOverride ?? messages.map(() => ({ status: 'ok' as const }));
    });

    return { state, dbMock, pushSendMock, resetState };
});

vi.mock("@/storage/db", () => ({ db: dbMock }));
vi.mock("@/app/push/pushSend", () => ({ sendPushNotifications: pushSendMock }));

// The real eventRouter is used so these tests exercise the production presence
// rule end to end — a regression in hasActiveUiClient fails them. Only the
// socket.io server is stubbed: `state.sockets` is what fetchSockets returns,
// and emit paths are swallowed.
import { eventRouter } from "@/app/events/eventRouter";
import { pushRoutes } from "./pushRoutes";

function stubIo() {
    const room = {
        timeout: () => room,
        fetchSockets: async () => {
            if (state.presenceError) throw new Error(state.presenceError);
            return state.sockets;
        },
        emit: () => undefined
    };
    return { in: () => room, to: () => room, except: () => room } as any;
}

const USER = "user-1";
const SESSION = "session-1";

async function buildApp(): Promise<Fastify> {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any) => { request.userId = USER; });
    pushRoutes(typed);
    await typed.ready();
    return typed;
}

async function postPushEvent(app: Fastify, sessionId = SESSION) {
    return app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/push-event`,
        headers: { authorization: 'Bearer t' },
        payload: { kind: 'done', title: 'It is ready!', body: 'session title' }
    });
}

describe('POST /v1/sessions/:sessionId/push-event', () => {
    let app: Fastify;

    beforeEach(async () => {
        resetState();
        state.sessions.push({ id: SESSION, accountId: USER });
        state.tokens.push({ id: 'tok-1', token: 'ExponentPushToken[aaa]' });
        eventRouter.init(stubIo());
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
        vi.clearAllMocks();
    });

    it('sends and reports the outcome when nothing is connected', async () => {
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'sent', tokens: 1 });
        expect(state.sent).toHaveLength(1);
    });

    it('sends when the phone is backgrounded while a coding session is live', async () => {
        // The regression this whole change exists for: the session's own socket
        // must not be mistaken for the user watching.
        state.sockets.push(
            { data: { clientType: 'session-scoped' } },
            { data: { clientType: 'machine-scoped' } },
            { data: { clientType: 'user-scoped', appState: 'background' } }
        );
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('suppresses and says so when a UI client is in the foreground', async () => {
        state.sockets.push({ data: { clientType: 'user-scoped', appState: 'active' } });
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ success: true, result: 'suppressed', reason: 'active-ui-client' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports no_tokens instead of claiming success', async () => {
        state.tokens.length = 0;
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'no_tokens' });
        expect(state.sent).toHaveLength(0);
    });

    it('reports partial delivery', async () => {
        state.tokens.push({ id: 'tok-2', token: 'ExponentPushToken[bbb]' });
        state.ticketOverride = [
            { status: 'ok' },
            { status: 'error', details: { error: 'DeviceNotRegistered' } }
        ];
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'partial', delivered: 1, tokens: 2 });
    });

    it('still sends when the presence check fails or times out', async () => {
        // Fail open: an infrastructure problem must not silence notifications.
        state.presenceError = 'operation has timed out';
        const res = await postPushEvent(app);
        expect(res.json()).toMatchObject({ result: 'sent' });
        expect(state.sent).toHaveLength(1);
    });

    it('reports failed, not partial, when nothing reaches Expo', async () => {
        state.ticketOverride = [{ status: 'error', message: 'Network error' }];
        const res = await postPushEvent(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ result: 'failed' });
    });

    it('404s for a session the caller does not own', async () => {
        const res = await postPushEvent(app, 'someone-elses-session');
        expect(res.statusCode).toBe(404);
        expect(state.sent).toHaveLength(0);
    });
});
