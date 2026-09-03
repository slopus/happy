import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['e2e/fixtures/mcp-app-console/*.test.ts'],
        testTimeout: 20_000,
    },
});
