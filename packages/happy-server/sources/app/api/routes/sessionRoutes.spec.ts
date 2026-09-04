import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Fastify } from '../types';

const { dbMock, setSessionRow, setSessionRows } = vi.hoisted(() => {
    let sessionRow: Record<string, unknown> | null = null;
    let sessionRows: Record<string, unknown>[] = [];
    const setSessionRow = (row: Record<string, unknown> | null) => {
        sessionRow = row;
    };
    const setSessionRows = (rows: Record<string, unknown>[]) => {
        sessionRows = rows;
    };
    const findFirst = vi.fn(async ({ where }: { where: { id?: string; accountId?: string } }) => {
        if (!sessionRow) return null;
        return where.id === sessionRow.id && where.accountId === sessionRow.accountId
            ? sessionRow
            : null;
    });
    return {
        dbMock: { session: { findFirst, findMany: vi.fn(async () => sessionRows), create: vi.fn() } },
        setSessionRow,
        setSessionRows,
    };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: { emitUpdate: vi.fn(), emitEphemeral: vi.fn() },
    buildNewSessionUpdate: vi.fn(),
    buildSessionActivityEphemeral: vi.fn(),
}));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: vi.fn() }));
vi.mock('@/app/session/sessionDelete', () => ({ sessionDelete: vi.fn() }));
vi.mock('@/utils/log', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { sessionRoutes } from './sessionRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const authorization = request.headers.authorization;
        if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
            return reply.code(401).send({ error: 'Unauthorized' });
        }
        request.userId = authorization.slice('Bearer '.length);
    });
    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

function ownedSessionRow() {
    return {
        id: 'session-1',
        accountId: 'user-1',
        seq: 3,
        metadata: 'encrypted-metadata',
        metadataVersion: 4,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: new Uint8Array([1, 2, 3]),
        active: true,
        lastActiveAt: new Date('2026-09-04T12:00:01.000Z'),
        createdAt: new Date('2026-09-04T12:00:00.000Z'),
        updatedAt: new Date('2026-09-04T12:00:01.000Z'),
    };
}

describe('sessionRoutes — GET /v2/sessions/:sessionId', () => {
    let app: Fastify;

    beforeEach(() => {
        setSessionRow(null);
        setSessionRows([]);
        dbMock.session.findFirst.mockClear();
        dbMock.session.findMany.mockClear();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    it('returns one owned session snapshot', async () => {
        setSessionRow(ownedSessionRow());
        app = await createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/v2/sessions/session-1',
            headers: { authorization: 'Bearer user-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            session: {
                id: 'session-1',
                seq: 3,
                metadata: 'encrypted-metadata',
                metadataVersion: 4,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: 'AQID',
                active: true,
                activeAt: 1_788_523_201_000,
                createdAt: 1_788_523_200_000,
                updatedAt: 1_788_523_201_000,
            },
        });
    });

    it('returns the same 404 for missing and foreign sessions', async () => {
        setSessionRow(ownedSessionRow());
        app = await createApp();

        const missing = await app.inject({
            method: 'GET',
            url: '/v2/sessions/missing-session',
            headers: { authorization: 'Bearer user-1' },
        });
        const foreign = await app.inject({
            method: 'GET',
            url: '/v2/sessions/session-1',
            headers: { authorization: 'Bearer user-2' },
        });

        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'Session not found' });
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toEqual({ error: 'Session not found' });
    });

    it('preserves lastMessage presence across legacy and V2 list responses', async () => {
        setSessionRows([ownedSessionRow()]);
        app = await createApp();

        const legacy = await app.inject({
            method: 'GET',
            url: '/v1/sessions',
            headers: { authorization: 'Bearer user-1' },
        });
        const active = await app.inject({
            method: 'GET',
            url: '/v2/sessions/active?limit=1',
            headers: { authorization: 'Bearer user-1' },
        });
        const page = await app.inject({
            method: 'GET',
            url: '/v2/sessions?limit=1',
            headers: { authorization: 'Bearer user-1' },
        });

        expect(legacy.statusCode).toBe(200);
        expect(legacy.json().sessions[0]).toHaveProperty('lastMessage', null);
        expect(active.statusCode).toBe(200);
        expect(active.json().sessions[0]).not.toHaveProperty('lastMessage');
        expect(page.statusCode).toBe(200);
        expect(page.json().sessions[0]).not.toHaveProperty('lastMessage');
    });
});
