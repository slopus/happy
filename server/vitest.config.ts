import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.spec.ts'],
  },
  // Restrict tsconfig resolution to server only.
  // Otherwise vite-tsconfig-paths may scan the repo and attempt to parse Expo tsconfigs.
  plugins: [tsconfigPaths({ projects: [resolve(__dirname, './tsconfig.json')] })]
}); 
