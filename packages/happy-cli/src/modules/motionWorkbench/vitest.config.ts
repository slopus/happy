import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// Run adapter tests without invoking the production CLI build or global integration setup.
export default defineConfig({
    resolve: { alias: { '@': resolve('./src') } },
    test: { include: ['src/modules/motionWorkbench/**/*.test.ts'], environment: 'node' },
});
