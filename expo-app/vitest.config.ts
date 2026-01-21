import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    define: {
        __DEV__: false,
    },
    test: {
        globals: false,
        environment: 'node',
        include: ['sources/**/*.{spec,test}.ts'],
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
            // Vitest runs in node; avoid parsing React Native's Flow entrypoint.
            'react-native': resolve('./sources/dev/reactNativeStub.ts'),
            // Use libsodium-wrappers in tests instead of the RN native binding.
            '@more-tech/react-native-libsodium': 'libsodium-wrappers',
            // Use node-safe platform adapters in tests (avoid static expo-crypto imports).
            '@/platform/cryptoRandom': resolve('./sources/platform/cryptoRandom.node.ts'),
            '@/platform/hmacSha512': resolve('./sources/platform/hmacSha512.node.ts'),
            '@/platform/randomUUID': resolve('./sources/platform/randomUUID.node.ts'),
            '@/platform/digest': resolve('./sources/platform/digest.node.ts'),
            // IMPORTANT: keep this after more specific `@/...` aliases (Vite resolves aliases in-order).
            '@': resolve('./sources'),
        },
    },
})
