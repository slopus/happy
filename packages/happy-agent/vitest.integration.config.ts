import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.integration.test.ts'],
        hookTimeout: 180_000,
        testTimeout: 180_000,
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
