import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        root: resolve(__dirname, 'src/renderer'),
        resolve: {
            alias: {
                '@renderer': resolve(__dirname, 'src/renderer/src'),
            },
            dedupe: ['react', 'react-dom'],
        },
        plugins: [react(), tailwindcss()],
        build: {
            rollupOptions: {
                input: resolve(__dirname, 'src/renderer/index.html'),
            },
        },
    },
})
