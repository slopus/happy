import { Prisma } from '@prisma/client';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    findSession: vi.fn(),
    findEvents: vi.fn(),
    persistEvent: vi.fn(),
    persistCheckpointEvent: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        session: { findFirst: mocks.findSession },
        sessionEvent: { findMany: mocks.findEvents },
    },
}));
vi.mock('@/app/events/persistSessionEvent', () => ({ persistSessionEvent: mocks.persistEvent }));
vi.mock('@/app/events/persistCheckpointSessionEvent', () => ({
    persistCheckpointSessionEvent: mocks.persistCheckpointEvent,
}));

import { getEventsQuerySchema, sendEventBodySchema } from './v3SessionEventRoutes';
import { v3SessionEventRoutes } from './v3SessionEventRoutes';

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    typed.decorate('authenticate', async (request: any, reply: any) => {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') return reply.code(401).send({ error: 'Unauthorized' });
        request.userId = userId;
    });

    // These cases are about the account path, so the session-scope decorator
    // stands in as the same account-only check. It has to be present: the
    // routes refuse to register without it rather than losing their preHandler.
    typed.decorate('authenticateSessionScope', (typed as any).authenticate);
    v3SessionEventRoutes(typed);
    await typed.ready();
    return typed;
}

describe('getEventsQuerySchema', () => {
    it('defaults order to asc when the caller does not send one', () => {
        const result = getEventsQuerySchema.parse({});
        expect(result.order).toBe('asc');
    });

    it('accepts order=desc for reverse pagination', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc' });
        expect(result.order).toBe('desc');
    });

    it('accepts order=asc explicitly', () => {
        const result = getEventsQuerySchema.parse({ order: 'asc' });
        expect(result.order).toBe('asc');
    });

    it('rejects any other order value with a validation error', () => {
        expect(() => getEventsQuerySchema.parse({ order: 'random' })).toThrow();
    });

    it('preserves existing after_seq / limit / type defaults alongside order', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc' });
        expect(result.after_seq).toBe(0);
        expect(result.limit).toBe(100);
        expect(result.type).toBeUndefined();
    });

    it('accepts before_seq as an optional reverse cursor (coerced to number)', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc', before_seq: '500' });
        expect(result.before_seq).toBe(500);
    });

    it('leaves before_seq undefined when absent', () => {
        const result = getEventsQuerySchema.parse({});
        expect(result.before_seq).toBeUndefined();
    });

    it('rejects before_seq below 1', () => {
        expect(() => getEventsQuerySchema.parse({ before_seq: 0 })).toThrow();
    });

    it('rejects sending after_seq and before_seq together (ambiguous cursor)', () => {
        expect(() =>
            getEventsQuerySchema.parse({ after_seq: 10, before_seq: 500 }),
        ).toThrow();
    });

    it('leaves legacy checkpoint history out unless include_legacy=1', () => {
        expect(getEventsQuerySchema.parse({}).include_legacy).toBeUndefined();
        expect(getEventsQuerySchema.parse({ include_legacy: '1' }).include_legacy).toBe('1');
        expect(() => getEventsQuerySchema.parse({ include_legacy: 'yes' })).toThrow();
    });
});

describe('sendEventBodySchema', () => {
    const checkpoint = {
        schemaVersion: 1,
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        checkpointId: 'a'.repeat(40),
        state: 'created',
        actor: 'agent',
        timestamp: 1_788_111_000_000,
    } as const;

    it('validates server-visible metadata when supplied for checkpoint events', () => {
        expect(sendEventBodySchema.parse({
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        })).toEqual({
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        });

        expect(sendEventBodySchema.safeParse({
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
        }).success).toBe(true);
    });

    it('rejects checkpoint metadata on unrelated session events', () => {
        expect(sendEventBodySchema.safeParse({
            eventType: 'session-end',
            content: 'encrypted-detail',
            checkpoint,
        }).success).toBe(false);
    });

    it('preserves legacy parsing that strips unrelated extra fields', () => {
        expect(sendEventBodySchema.parse({
            eventType: 'session-end',
            content: 'encrypted-detail',
            legacyExtra: 'ignored',
        })).toEqual({
            eventType: 'session-end',
            content: 'encrypted-detail',
        });
    });
});

describe('checkpoint session event route', () => {
    const checkpoint = {
        schemaVersion: 1,
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        checkpointId: 'a'.repeat(40),
        state: 'created',
        actor: 'agent',
        timestamp: 1_788_111_000_000,
    } as const;

    beforeEach(() => vi.clearAllMocks());

    it.each(['checkpoint-snapshot', 'checkpoint-rewind'])('persists and reads legacy %s without fabricating protection metadata', async (eventType) => {
        const createdAt = new Date('2026-09-23T00:00:00Z');
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
        mocks.persistEvent.mockResolvedValue({ id: 'legacy-1', seq: 4, createdAt });
        mocks.findEvents.mockResolvedValue([{
            id: 'legacy-1', seq: 4, eventType, checkpoint: null,
            content: { t: 'encrypted', c: 'encrypted-web-history' },
            createdAt, updatedAt: createdAt,
        }]);
        const app = await createApp();
        const response = await app.inject({
            method: 'POST', url: '/v3/sessions/session-1/events',
            headers: { 'x-user-id': 'account-1' },
            payload: { eventType, content: 'encrypted-web-history' },
        });
        expect(response.statusCode).toBe(200);
        expect(mocks.persistEvent).toHaveBeenCalledWith({
            sessionId: 'session-1', eventType, content: 'encrypted-web-history',
        });
        expect(mocks.persistCheckpointEvent).not.toHaveBeenCalled();
        expect(response.json().event).not.toHaveProperty('idempotent');
        const history = await app.inject({
            method: 'GET', url: `/v3/sessions/session-1/events?type=${eventType}&include_legacy=1`,
            headers: { 'x-user-id': 'account-1' },
        });
        expect(history.statusCode).toBe(200);
        expect(mocks.findEvents.mock.calls[0][0].where).not.toHaveProperty('checkpoint');
        expect(history.json().events[0]).toMatchObject({
            id: 'legacy-1', eventType, content: { t: 'encrypted', c: 'encrypted-web-history' },
        });
        expect(history.json().events[0]).not.toHaveProperty('checkpoint');
        await app.close();
    });

    // Released Desktop builds drop the whole timeline on one envelope-less
    // entry, so they must never receive legacy rows they did not ask for.
    it.each(['checkpoint-snapshot', 'checkpoint-rewind'])('hides legacy %s rows from readers that do not opt in', async (eventType) => {
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
        mocks.findEvents.mockResolvedValue([]);
        const app = await createApp();
        const response = await app.inject({
            method: 'GET', url: `/v3/sessions/session-1/events?type=${eventType}`,
            headers: { 'x-user-id': 'account-1' },
        });
        expect(response.statusCode).toBe(200);
        expect(mocks.findEvents.mock.calls[0][0].where).toEqual({
            sessionId: 'session-1',
            seq: { gt: 0 },
            eventType,
            checkpoint: { not: Prisma.DbNull },
        });
        await app.close();
    });

    it.each([
        '/v3/sessions/session-1/events?type=message-hidden',
        '/v3/sessions/session-1/events',
    ])('leaves reads other than checkpoint types unfiltered (%s)', async (url) => {
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
        mocks.findEvents.mockResolvedValue([]);
        const app = await createApp();
        const response = await app.inject({ method: 'GET', url, headers: { 'x-user-id': 'account-1' } });
        expect(response.statusCode).toBe(200);
        expect(mocks.findEvents.mock.calls[0][0].where).not.toHaveProperty('checkpoint');
        await app.close();
    });

    it.each([null, {}, { ...checkpoint, schemaVersion: 2 }, { ...checkpoint, filePath: '/private/file' }])(
        'does not downgrade invalid checkpoint metadata to legacy persistence (%j)', async (invalidCheckpoint) => {
            const app = await createApp();
            const response = await app.inject({
                method: 'POST', url: '/v3/sessions/session-1/events',
                headers: { 'x-user-id': 'account-1' },
                payload: { eventType: 'checkpoint-snapshot', content: 'cipher', checkpoint: invalidCheckpoint },
            });
            expect(response.statusCode).toBe(400);
            expect(mocks.persistEvent).not.toHaveBeenCalled();
            expect(mocks.persistCheckpointEvent).not.toHaveBeenCalled();
            await app.close();
        },
    );

    it.each([undefined, 'account-1'])('denies legacy writes without session ownership (%s)', async (userId) => {
        mocks.findSession.mockResolvedValue(null);
        const app = await createApp();
        const response = await app.inject({
            method: 'POST', url: '/v3/sessions/foreign/events',
            headers: userId ? { 'x-user-id': userId } : {},
            payload: { eventType: 'checkpoint-rewind', content: 'cipher' },
        });
        expect(response.statusCode).toBe(userId ? 404 : 401);
        expect(mocks.persistEvent).not.toHaveBeenCalled();
        expect(mocks.persistCheckpointEvent).not.toHaveBeenCalled();
        await app.close();
    });

    it('persists a checkpoint event only under the authenticated session owner', async () => {
        const createdAt = new Date('2026-09-02T00:00:00.000Z');
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
        mocks.persistCheckpointEvent.mockResolvedValue({
            id: 'event-1',
            seq: 3,
            createdAt,
            idempotent: false,
        });
        const app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v3/sessions/session-1/events',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                eventType: 'checkpoint-snapshot',
                content: 'encrypted-detail',
                checkpoint,
            },
        });

        expect(response.statusCode).toBe(200);
        expect(mocks.findSession).toHaveBeenCalledWith({
            where: { id: 'session-1', accountId: 'account-1' },
            select: { id: true },
        });
        expect(mocks.persistCheckpointEvent).toHaveBeenCalledWith({
            sessionId: 'session-1',
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        });
        expect(mocks.persistEvent).not.toHaveBeenCalled();
        expect(response.json()).toEqual({
            event: {
                id: 'event-1',
                seq: 3,
                createdAt: createdAt.getTime(),
                idempotent: false,
            },
        });
        await app.close();
    });

    it('does not reveal or persist another account session', async () => {
        mocks.findSession.mockResolvedValue(null);
        const app = await createApp();

        const response = await app.inject({
            method: 'POST',
            url: '/v3/sessions/session-foreign/events',
            headers: { 'x-user-id': 'account-1' },
            payload: {
                eventType: 'checkpoint-rewind',
                content: 'encrypted-detail',
                checkpoint,
            },
        });

        expect(response.statusCode).toBe(404);
        expect(mocks.persistCheckpointEvent).not.toHaveBeenCalled();
        expect(mocks.persistEvent).not.toHaveBeenCalled();
        await app.close();
    });

    it('returns validated checkpoint metadata with the encrypted timeline event', async () => {
        const createdAt = new Date('2026-09-02T00:00:00.000Z');
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
        mocks.findEvents.mockResolvedValue([{
            id: 'event-1',
            eventType: 'checkpoint-snapshot',
            seq: 3,
            content: { t: 'encrypted', c: 'encrypted-detail' },
            checkpoint,
            createdAt,
            updatedAt: createdAt,
        }]);
        const app = await createApp();

        const response = await app.inject({
            method: 'GET',
            url: '/v3/sessions/session-1/events?type=checkpoint-snapshot',
            headers: { 'x-user-id': 'account-1' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            events: [{
                id: 'event-1',
                eventType: 'checkpoint-snapshot',
                seq: 3,
                content: { t: 'encrypted', c: 'encrypted-detail' },
                checkpoint,
                createdAt: createdAt.getTime(),
                updatedAt: createdAt.getTime(),
            }],
            hasMore: false,
        });
        await app.close();
    });
});
