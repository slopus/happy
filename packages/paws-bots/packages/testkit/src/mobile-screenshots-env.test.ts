import { afterEach, describe, expect, it, vi } from "vitest";

const developerUrl = "postgres://owner:fixture@127.0.0.1:5433/developer_fixture";
const disposableUrl = "postgres://test:fixture@127.0.0.1:55432/disposable_fixture";

// The Prisma config loads `.env` files into the process; drop whatever they added.
const keysBefore = new Set(Object.keys(process.env));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const key of Object.keys(process.env)) if (!keysBefore.has(key)) delete process.env[key];
});

describe("mobile screenshot environment", () => {
  it("points Prisma migrations at DATABASE_URL's database over the root .env", async () => {
    vi.stubEnv("DATABASE_URL", disposableUrl);
    // The Prisma config is imported after the CLI environment is configured, and dotenv
    // never overrides a variable that is already set.
    const { configureEnvironment } = await import("./cli/mobile-screenshots.js");
    configureEnvironment();
    process.env.DATABASE_MIGRATION_URL ??= developerUrl;

    const { default: prismaConfig } = await import("../../db/prisma.config.js");

    expect(prismaConfig.datasource?.url).toBe(disposableUrl);
  });

  it("replaces a migration URL the shell already exported", async () => {
    vi.stubEnv("DATABASE_URL", disposableUrl);
    vi.stubEnv("DATABASE_MIGRATION_URL", developerUrl);
    const { configureEnvironment } = await import("./cli/mobile-screenshots.js");
    configureEnvironment();

    const { default: prismaConfig } = await import("../../db/prisma.config.js");

    expect(prismaConfig.datasource?.url).toBe(disposableUrl);
  });
});
