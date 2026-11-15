import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { computerTestSandbox } from "../computer-test-config.js";
import { disposableDatabaseEnv, startPostgres } from "./postgres.js";
import { runProcess } from "./process.js";

async function main() {
  const { values } = parseArgs({ options: { sandbox: { type: "string", default: "boat" } } });
  const sandbox = computerTestSandbox(values.sandbox);
  loadRootEnv();
  for (const key of [sandbox.apiKeyEnv, "OPENROUTER_API_KEY", "COMPUTER_E2E_MODEL"]) {
    if (!process.env[key]) throw new Error(`${key} is required`);
  }
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-e2e-run-"));
  const database = await startPostgres();
  const env = {
    ...process.env,
    ...disposableDatabaseEnv(database.getConnectionUri()),
    RUN_COMPUTER_E2E: "1",
    VERIFY_PROVIDERS: "1",
    VERIFY_LOGGING: "1",
    LOG_LEVEL: "error",
    LOG_FORMAT: "json",
    COMPOSIO_API_KEY: "",
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: sandbox.provider,
    AGENT_RUNTIME: "pi",
    BETTER_AUTH_SECRET: "computer-e2e-auth-secret-32chars",
    ENCRYPTION_KEY: "computer-e2e-encryption-key-32chars",
    SANDBOX_SUPERVISOR_TOKEN: "computer-e2e-supervisor-token-32chars",
    SCREEN_PROXY_SECRET: "computer-e2e-screen-proxy-secret-32chars",
    BETTER_AUTH_URL: "http://127.0.0.1:5173",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    DATA_DIR: dataDir,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
  };
  try {
    execFileSync("pnpm", ["--filter", "@rakazo/db", "generate"], {
      stdio: "inherit",
      env,
    });
    execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env,
      cwd: path.resolve("packages/db"),
    });
    await runProcess(
      "pnpm",
      ["exec", "vitest", "run", "packages/testkit/src/computer-use.e2e.test.ts"],
      env,
    );
  } finally {
    await database.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
