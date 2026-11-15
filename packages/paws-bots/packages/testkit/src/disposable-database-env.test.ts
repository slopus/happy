import { afterEach, describe, expect, it, vi } from "vitest";
import { disposableDatabaseEnv } from "./cli/postgres.js";

const developerUrl = "postgres://owner:fixture@127.0.0.1:5433/developer_fixture";
const disposableUrl = "postgres://test:fixture@127.0.0.1:55432/disposable_fixture";

// The Prisma config loads `.env` files into the process; drop whatever they added.
const keysBefore = new Set(Object.keys(process.env));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const key of Object.keys(process.env)) if (!keysBefore.has(key)) delete process.env[key];
});

describe("disposable database env", () => {
  it("points Prisma migrations at the disposable database over inherited URLs", async () => {
    const inherited: Record<string, string> = {
      DATABASE_URL: developerUrl,
      DATABASE_MIGRATION_URL: developerUrl,
      REALTIME_DATABASE_URL: developerUrl,
    };
    const env = { ...inherited, ...disposableDatabaseEnv(disposableUrl) };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    // The Prisma config reads the environment when it loads, so it is imported after stubbing.
    const { default: prismaConfig } = await import("../../db/prisma.config.js");

    expect(prismaConfig.datasource?.url).toBe(disposableUrl);
    expect(env).toEqual({
      DATABASE_URL: disposableUrl,
      DATABASE_MIGRATION_URL: disposableUrl,
      REALTIME_DATABASE_URL: disposableUrl,
    });
  });
});
