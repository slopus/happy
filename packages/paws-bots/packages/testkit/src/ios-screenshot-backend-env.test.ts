import { tmpdir } from "node:os";
import path from "node:path";
import { databaseUrls } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const developerUrl = "postgres://owner:fixture@127.0.0.1:5433/developer_fixture";
const serverUrl = "postgres://test:fixture@127.0.0.1:55432/postgres";

const migrateEnv = vi.hoisted(() => ({ value: undefined as NodeJS.ProcessEnv | undefined }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  // Capture the environment `pnpm db:migrate` would get, then stop before the API starts.
  execFileSync: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    migrateEnv.value = { ...options.env };
    throw new Error("stop after migrate");
  },
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  createDb: () => ({
    pool: { query: async () => ({ rows: [] }), end: async () => {} },
    prisma: { $disconnect: async () => {} },
  }),
}));

const envBefore = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
});

describe("iOS screenshot backend environment", () => {
  it("migrates the catalog's fresh database over inherited database URLs", async () => {
    process.env.DATABASE_MIGRATION_URL = developerUrl;
    process.env.REALTIME_DATABASE_URL = developerUrl;
    const { startIosScreenshotBackend } = await import("./cli/ios-screenshot-backend.js");

    await expect(
      startIosScreenshotBackend({
        root: process.cwd(),
        serverUrl,
        port: 0,
        dataDir: path.join(tmpdir(), `rakazo-ios-backend-env-${process.pid}`),
      }),
    ).rejects.toThrow("stop after migrate");

    const urls = databaseUrls(migrateEnv.value ?? {});
    expect(urls.url).toMatch(/\/rakazo_ios_screenshots$/);
    expect(urls.migrationUrl).toBe(urls.url);
    expect(migrateEnv.value?.REALTIME_DATABASE_URL).toBe(urls.url);
  });
});
