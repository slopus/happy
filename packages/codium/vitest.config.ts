import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: {
        alias: { '@': resolve(__dirname, 'sources') },
    },
    test: {
        environment: 'node',
        include: ['sources/**/*.{test,spec}.ts'],
    },
})
