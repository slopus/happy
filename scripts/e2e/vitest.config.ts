import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
    test: {
        // Global test settings
        globals: true,
        testTimeout: 120000, // 2 minutes for E2E tests
        hookTimeout: 180000, // 3 minutes for setup/teardown

        // Global setup/teardown
        globalSetup: ['./setup.ts'],

        // File patterns
        include: ['tests/**/*.test.ts'],
        exclude: ['**/node_modules/**'],

        // Reporter configuration for clean output
        reporters: ['verbose'],

        // Run tests sequentially by default (E2E tests often share state)
        // Individual test files can opt-in to parallelism
        sequence: {
            concurrent: false,
        },

        // Pool configuration
        // Use 'forks' for better isolation between test files
        pool: 'forks',
        poolOptions: {
            forks: {
                // Each test file gets its own process
                singleFork: false,
                // Limit parallelism to avoid resource contention
                maxForks: 4,
                minForks: 1,
            },
        },

        // Projects for different test categories
        // This allows running specific categories of tests
        // Commented out as we'll use file patterns instead for simplicity
        // projects: [
        //     {
        //         name: 'webapp',
        //         include: ['tests/webapp/**/*.test.ts'],
        //     },
        //     {
        //         name: 'cli',
        //         include: ['tests/cli/**/*.test.ts'],
        //     },
        //     {
        //         name: 'integration',
        //         include: ['tests/integration/**/*.test.ts'],
        //         // Integration tests must run sequentially
        //         sequence: { concurrent: false },
        //         poolOptions: { forks: { singleFork: true } },
        //     },
        // ],
    },

    resolve: {
        alias: {
            '@helpers': path.resolve(import.meta.dirname, 'helpers'),
        },
    },
});
