import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            lib: {
                entry: resolve(__dirname, 'sources/boot/main/index.ts'),
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            lib: {
                entry: resolve(__dirname, 'sources/boot/preload/index.ts'),
            },
        },
    },
    renderer: {
        root: resolve(__dirname, 'sources'),
        resolve: {
            alias: {
                '@': resolve(__dirname, 'sources'),
            },
            dedupe: ['react', 'react-dom'],
        },
        plugins: [react(), tailwindcss()],
        build: {
            rollupOptions: {
                input: resolve(__dirname, 'sources/index.html'),
            },
        },
    },
})
