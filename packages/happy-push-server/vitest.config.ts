import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Node (not workerd): local port binding is unavailable in the
// sandbox the repo's agents use, and the Worker only needs fetch, Web Crypto,
// and D1 — all provided by Node 24 plus the node:sqlite D1 adapter in test/.
export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    test: {
        globals: false,
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
