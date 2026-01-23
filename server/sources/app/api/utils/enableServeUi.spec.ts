import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableServeUi } from './enableServeUi';

describe('enableServeUi', () => {
    it('responds 404 when index.html is missing (instead of throwing)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-ui-missing-'));
        const app = Fastify();

        enableServeUi(app as any, { dir, prefix: '/', mountRoot: true });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/' });
        expect(res.statusCode).toBe(404);
        expect(res.headers['cache-control']).toBe('no-cache');
    });
});
