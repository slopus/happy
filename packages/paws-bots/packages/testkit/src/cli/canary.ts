import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { DisposablePostgres } from "./postgres.js";
import { disposableDatabaseEnv, startPostgres } from "./postgres.js";

async function main() {
  loadRootEnv();
  const runOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  if (
    !process.env.E2B_API_KEY &&
    !process.env.BOAT_API_KEY &&
    !process.env.BOXD_API_KEY &&
    !process.env.INSTABOX_API_KEY &&
    !process.env.NOVITA_API_KEY &&
    !process.env.CREATEOS_SANDBOX_API_KEY &&
    !runOpenRouter
  ) {
    throw new Error(
      "E2B_API_KEY, BOAT_API_KEY, BOXD_API_KEY, INSTABOX_API_KEY, NOVITA_API_KEY, CREATEOS_SANDBOX_API_KEY, or OPENROUTER_API_KEY is required for live provider canaries",
    );
  }

  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-canary-"));
  let postgres: DisposablePostgres | undefined;
  try {
    if (runOpenRouter) postgres = await startPostgres();
    const env = {
      ...process.env,
      ...disposableDatabaseEnv(postgres?.getConnectionUri() ?? ""),
      VERIFY_PROVIDERS: "1",
      WAKEUP_DRIVER: "memory",
      AGENT_RUNTIME: "pi",
      SANDBOX_PROVIDER: "fake",
      CLOUD_AGENT_PROVIDER: "emulator",
      COMPOSIO_API_KEY: "",
      CURSOR_API_KEY: "",
      MAX_TOOL_CALLS_PER_TURN: "24",
      BETTER_AUTH_SECRET: "provider-canary-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "provider-canary-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "provider-canary-supervisor-token-at-least-32-characters",
      SCREEN_PROXY_SECRET: "provider-canary-screen-proxy-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      DATA_DIR: dataDir,
    };
    if (postgres) {
      execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env });
      execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
        stdio: "inherit",
        env,
        cwd: path.resolve("packages/db"),
      });
    }
    execSync(
      "pnpm exec vitest run --no-file-parallelism packages/testkit/src/providers.canary.test.ts packages/testkit/src/release-watch.canary.test.ts",
      { stdio: "inherit", env },
    );
  } finally {
    try {
      await postgres?.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
