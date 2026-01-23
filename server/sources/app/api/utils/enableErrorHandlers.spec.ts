import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enableErrorHandlers } from './enableErrorHandlers';

describe('enableErrorHandlers', () => {
    it('responds 404 when UI index.html is missing (instead of 500)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happy-ui-missing-'));

        const prevUiDir = process.env.HAPPY_SERVER_UI_DIR;
        const prevUiPrefix = process.env.HAPPY_SERVER_UI_PREFIX;
        process.env.HAPPY_SERVER_UI_DIR = dir;
        process.env.HAPPY_SERVER_UI_PREFIX = '/';

        try {
            const app = Fastify();
            enableErrorHandlers(app as any);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/' });
            expect(res.statusCode).toBe(404);
        } finally {
            if (typeof prevUiDir === 'string') process.env.HAPPY_SERVER_UI_DIR = prevUiDir;
            else delete process.env.HAPPY_SERVER_UI_DIR;

            if (typeof prevUiPrefix === 'string') process.env.HAPPY_SERVER_UI_PREFIX = prevUiPrefix;
            else delete process.env.HAPPY_SERVER_UI_PREFIX;
        }
    });
});

