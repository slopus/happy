import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
    resolve: { alias: { '@': resolve('./src') } },
    test: { environment: 'node', include: ['src/personal/*.live.integration.test.ts'], testTimeout: 180_000 },
});
