import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/storage/db', () => ({
    get db() { return state.client; },
}));

import { v3SessionEventRoutes } from './v3SessionEventRoutes';

let sql: string;
let pg: PGlite;
let client: PrismaClient;

const envelope = {
    schemaVersion: 1,
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    checkpointId: 'a'.repeat(40),
    state: 'created',
    actor: 'agent',
    timestamp: 1_788_111_000_000,
} as const;

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    sql = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
});
beforeEach(async () => {
    pg = new PGlite(); await pg.exec(sql);
    client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    state.client = client;
    await client.account.create({ data: { id: 'account-1', publicKey: 'account-1' } });
    await client.session.create({ data: { id: 'session-1', tag: 'tag', accountId: 'account-1', metadata: '' } });
    await client.sessionEvent.createMany({ data: [
        { sessionId: 'session-1', seq: 1, eventType: 'checkpoint-snapshot', content: { t: 'encrypted', c: 'daemon' }, checkpoint: envelope },
        { sessionId: 'session-1', seq: 2, eventType: 'checkpoint-snapshot', content: { t: 'encrypted', c: 'web' } },
        { sessionId: 'session-1', seq: 3, eventType: 'checkpoint-snapshot', content: { t: 'encrypted', c: 'web' } },
    ] });
});
afterEach(async () => { await client?.$disconnect(); await pg?.close(); });

async function read(query: string) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
    const authenticate = async (request: any) => { request.userId = 'account-1'; };
    typed.decorate('authenticate', authenticate);
    typed.decorate('authenticateSessionScope', authenticate);
    v3SessionEventRoutes(typed);
    await typed.ready();
    const response = await typed.inject({ method: 'GET', url: `/v3/sessions/session-1/events?${query}` });
    await typed.close();
    return response.json() as { events: Array<{ seq: number }>; hasMore: boolean };
}

describe('checkpoint history reads against the stored rows', () => {
    it('serves only protected checkpoints, with a cursor that ignores legacy rows, to readers that do not opt in', async () => {
        const page = await read('type=checkpoint-snapshot&limit=1');
        expect(page.events.map((event) => event.seq)).toEqual([1]);
        expect(page.hasMore).toBe(false);
    });

    it('serves legacy web history alongside protected checkpoints when include_legacy=1', async () => {
        const page = await read('type=checkpoint-snapshot&include_legacy=1&order=desc');
        expect(page.events.map((event) => event.seq)).toEqual([3, 2, 1]);
    });
});
