import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.test.ts'],
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
            '#auth': resolve('./src/auth'),
            '#claude': resolve('./src/claude'),
            '#commands': resolve('./src/commands'),
            '#handlers': resolve('./src/handlers'),
            '#session': resolve('./src/session'),
            '#socket': resolve('./src/socket'),
            '#utils': resolve('./src/utils'),
        },
    },
})