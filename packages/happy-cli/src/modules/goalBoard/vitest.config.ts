import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
// A targeted unit suite must not invoke the production CLI build/global integration setup.
export default defineConfig({
    resolve: { alias: { '@': resolve('./src') } },
    test: { include: ['src/modules/goalBoard/**/*.test.ts', 'src/daemon/projectGoalRuntime.test.ts', 'src/api/apiSession.test.ts'], environment: 'node' },
});
