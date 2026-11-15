import { defineConfig } from "@playwright/test";

// These local fixtures exercise the real Vite proxy without starting an API, database, or Electron.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "screen-proxy-isolation.spec.ts",
  workers: 1,
  use: { headless: true },
});
