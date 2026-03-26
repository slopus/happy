import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'vendor/**/*.test.ts',
      'extensions/**/*.test.ts',
      'tests/**/*.test.ts'
    ]
  }
});
