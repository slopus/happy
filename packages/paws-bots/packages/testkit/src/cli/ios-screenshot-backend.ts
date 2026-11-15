import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import {
  BillingEmulator,
  ComposioConnector,
  EmailEmulator,
  FakeComposioClient,
  listPiCatalog,
  MessagingTeamChatEmulator,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { createModelConnectionFixtureFetch } from "../model-connection-fixture.js";
import { PluginMarketplaceFixture } from "../plugin-marketplace-fixture.js";
import { disposableDatabaseEnv } from "./postgres.js";

/**
 * An isolated API for the iOS catalog: scripted models, a fake sandbox, and offline billing,
 * wallet, and board, so every screen renders without a hosted provider.
 */
export async function startIosScreenshotBackend(input: {
  root: string;
  /** Any database on the server to use; the catalog gets its own fresh one beside it. */
  serverUrl: string;
  port: number;
  dataDir: string;
}) {
  const databaseUrl = await recreateDatabase(input.serverUrl);
  await rm(input.dataDir, { recursive: true, force: true });
  const apiUrl = `http://127.0.0.1:${input.port}`;
  Object.assign(process.env, {
    NODE_ENV: "test",
    // Migrations follow DATABASE_MIGRATION_URL, so an inherited one must not win.
    ...disposableDatabaseEnv(databaseUrl),
    WAKEUP_DRIVER: "memory",
    SANDBOX_PROVIDER: "fake",
    AGENT_RUNTIME: "scripted",
    CLOUD_AGENT_PROVIDER: "emulator",
    RAKAZO_LIVE_MODEL_CATALOG: "off",
    COMPOSIO_API_KEY: "",
    BETTER_AUTH_URL: apiUrl,
    WEB_ORIGIN: "http://127.0.0.1:5180",
    API_HOST: "127.0.0.1",
    API_PORT: String(input.port),
    API_URL: apiUrl,
    DATA_DIR: input.dataDir,
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    TICKET_BOARD_ENABLED: "true",
    PAYMENT_WALLET_PROVIDER: "emulator",
    LOG_LEVEL: "warn",
    CI: "1",
  });

  execFileSync("pnpm", ["db:migrate"], { cwd: input.root, env: process.env, stdio: "inherit" });

  const { createApp } = await import("@rakazo/api/app");
  // The same offline marketplace, app catalog, and model list the web end-to-end tests use.
  const thirdParties = new ThirdPartyConnectorEmulator();
  const marketplace = new PluginMarketplaceFixture(thirdParties.fetch);
  const billing = new BillingEmulator({ modelCredits: true });
  const handles = await createApp({
    databaseUrl,
    dataDir: input.dataDir,
    apiHost: "127.0.0.1",
    apiUrl,
    composio: new ComposioConnector({ client: new FakeComposioClient() }),
    email: new EmailEmulator(),
    billing,
    // A chat app, so Messaging and its conversations appear.
    messaging: new MessagingTeamChatEmulator({ provider: "slack" }),
    modelConnectionFetch: createModelConnectionFixtureFetch(listPiCatalog()),
    remoteConnectors: { fetch: marketplace.fetch, resolveHostname: thirdParties.resolveHostname },
    pluginRepoFetcher: marketplace.repo,
    pluginMarketplaceRead: marketplace.index,
    integrationsCatalogUrl: "https://catalog.example.test/",
  });
  const server = serve({
    fetch: handles.app.fetch,
    // Loopback only: the simulator shares it, and the fixture password is public.
    hostname: "127.0.0.1",
    port: input.port,
  }) as Server;
  await waitForHealth(`${apiUrl}/health`);
  return {
    apiUrl,
    databaseUrl,
    completeCheckout: (customerId: string) => {
      billing.completeByokCheckout(customerId);
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handles.stop().catch(() => undefined);
    },
  };
}

const DATABASE = "rakazo_ios_screenshots";

/** A fresh database every run, so screenshots never depend on what an earlier run left. */
async function recreateDatabase(serverUrl: string) {
  const admin = new URL(serverUrl);
  admin.pathname = "/postgres";
  const db = createDb(admin.toString(), { applicationName: "ios-screenshots" });
  try {
    await db.pool.query(`drop database if exists ${DATABASE} with (force)`);
    await db.pool.query(`create database ${DATABASE}`);
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  const target = new URL(serverUrl);
  target.pathname = `/${DATABASE}`;
  return target.toString();
}

async function waitForHealth(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await fetch(url).then(
        (response) => response.ok,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The screenshot API did not answer ${url}`);
}
