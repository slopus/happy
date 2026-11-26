import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['e2e/fixtures/project-goals/canvasPerfRpc.test.ts'],
    },
    resolve: {
        alias: {
            '@': resolve('./sources'),
            '@slopus/happy-wire': resolve('../happy-wire/dist/index.mjs'),
        },
    },
});
