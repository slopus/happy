import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        globalSetup: ['./src/test-setup.ts'],
        projects: [
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['src/**/*.test.ts'],
                    exclude: ['src/**/*.integration.test.ts'],
                    sequence: {
                        groupOrder: 0,
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration-empty',
                    fileParallelism: false,
                    hookTimeout: 120_000,
                    maxWorkers: 1,
                    minWorkers: 1,
                    testTimeout: 60_000,
                    include: [
                        'src/claude/claude.integration.test.ts',
                        'src/codex/codex.integration.test.ts',
                        'src/sandbox/network.integration.test.ts',
                    ],
                    setupFiles: ['./src/testing/integration.setup.empty.ts'],
                    sequence: {
                        groupOrder: 1,
                    },
                },
            },
            {
                extends: true,
                test: {
                    name: 'integration-authenticated',
                    fileParallelism: false,
                    hookTimeout: 120_000,
                    maxWorkers: 1,
                    minWorkers: 1,
                    testTimeout: 60_000,
                    include: [
                        'src/daemon/daemon.integration.test.ts',
                        'src/openclaw/openclaw.integration.test.ts',
                    ],
                    setupFiles: ['./src/testing/integration.setup.authenticated.ts'],
                    sequence: {
                        groupOrder: 2,
                    },
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
