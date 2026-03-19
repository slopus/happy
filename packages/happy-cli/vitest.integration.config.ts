import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

import dotenv from 'dotenv'

const testEnv = dotenv.config({
    path: '.env.integration-test'
}).parsed

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        include: ['src/**/*.integration.test.ts'],
        globalSetup: ['./src/test-setup.ts'],
        env: {
            ...process.env,
            ...testEnv,
        }
    },
    resolve: {
        alias: {
            '@': resolve('./src'),
        },
    },
})
