import { execSync } from "node:child_process";
import { globSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { runAsSystem as RunAsSystem } from "@rakazo/db";
import { createModelConnectionFixtureFetch } from "../model-connection-fixture.js";
import { PluginMarketplaceFixture } from "../plugin-marketplace-fixture.js";
import { startPostgres } from "./postgres.js";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const shard = shardArg?.slice("--shard=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "novita", "daytona", "boat", "boxd", "instabox"].includes(sandboxProvider)) {
  throw new Error(
    'Sandbox must be "fake", "e2b", "novita", "daytona", "boat", "boxd", or "instabox"',
  );
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "novita" && !process.env.NOVITA_API_KEY) {
  throw new Error("NOVITA_API_KEY is required when --sandbox=novita");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "boat" && !process.env.BOAT_API_KEY) {
  throw new Error("BOAT_API_KEY is required when --sandbox=boat");
}
if (sandboxProvider === "boxd" && !process.env.BOXD_API_KEY) {
  throw new Error("BOXD_API_KEY is required when --sandbox=boxd");
}
if (sandboxProvider === "instabox" && !process.env.INSTABOX_API_KEY) {
  throw new Error("INSTABOX_API_KEY is required when --sandbox=instabox");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await startPostgres();
  try {
    // Migrations run as the container superuser and the e2e API connects as the
    // runtime login, so row-level security is enforced as in a deployment.
    // Test code that seeds or inspects rows directly connects as the owner.
    const migrationUrl = container.getConnectionUri();
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = "rakazo_app";
    runtimeUrl.password = "rakazo-test-runtime";
    const databaseUrl = runtimeUrl.toString();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_MIGRATION_URL = migrationUrl;
    process.env.REALTIME_DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    process.env.RAKAZO_LIVE_MODEL_CATALOG = "off";
    if (!integration) {
      process.env.TICKET_BOARD_ENABLED = "true";
      process.env.PHONE_CALLS_ENABLED = "true";
      process.env.INBOUND_EMAIL_DOMAIN = "bots.rakazo.test";
      process.env.INBOUND_EMAIL_SECRET = "test-inbound-email-secret-test-32chars";
      // The offline wallet, so Settings shows Wallet and sign-in completes without a provider.
      process.env.PAYMENT_WALLET_PROVIDER = "emulator";
      process.env.RAKAZO_NAV_LINKS = JSON.stringify([
        { id: "clients", label: "Clients", path: "/ext/clients/" },
      ]);
    }
    // Playwright/E2E force the offline cloud-agent emulator; clear Cursor keys so cards never hit a live VM.
    process.env.CLOUD_AGENT_PROVIDER = "emulator";
    delete process.env.CURSOR_API_KEY;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    // Model and speech fixtures listen on loopback, and most test accounts are not the owner.
    process.env.MCP_ALLOW_PRIVATE_ENDPOINT = "true";
    if (!integration) {
      // The scripted bot registers a stdio server, and the MCP settings offer stdio.
      process.env.MCP_STDIO_ENABLED = "true";
      process.env.MCP_STDIO_ALLOWED_COMMANDS = "echo";
    }
    process.env.CI = "1";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm db:migrate", { stdio: "inherit", env: process.env });

    if (integration) {
      // Every *.postgres.test.ts file runs here, so a new one cannot be left out;
      // the other suites need the database too but carry no suffix.
      const suites = [
        ...globSync("{apps,packages}/*/src/**/*.postgres.test.ts").sort(),
        "packages/testkit/src/journeys.test.ts",
        "packages/testkit/src/authorization.test.ts",
        "packages/testkit/src/attachments.test.ts",
        "packages/testkit/src/voice.test.ts",
        "packages/testkit/src/search.test.ts",
        "packages/testkit/src/executor-lifecycle.test.ts",
        "packages/testkit/src/connections.test.ts",
        "packages/testkit/src/bot-secrets.test.ts",
      ];
      // --spec=<part of a path> runs only the matching suites.
      const selected = e2eSpec ? suites.filter((suite) => suite.includes(e2eSpec)) : suites;
      if (!selected.length) throw new Error(`No integration suite matches ${e2eSpec}`);
      // Files run in parallel, each on its own copy of the migrated database (pin-test-env.ts).
      await runProcess(
        "pnpm",
        ["exec", "vitest", "run", ...(shard ? ["--shard", shard] : []), ...selected],
        {
          ...process.env,
          COPY_TEST_DATABASE: "1",
          OPENROUTER_API_KEY: "",
          MODEL_API_KEY: "",
          // A developer .env may say development, which changes defaults such as encryption.
          NODE_ENV: "test",
        },
      );
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    const [
      {
        ComposioConnector,
        FakeComposioClient,
        listPiCatalog,
        DestinationEmulator,
        EmailEmulator,
        PipedreamConnector,
        ThirdPartyConnectorEmulator,
        UserDeviceEmulator,
      },
      { createApp },
      { drainUnscopedDatabaseAccess, runAsSystem },
    ] = await Promise.all([
      import("@rakazo/adapters"),
      import("@rakazo/api/app"),
      import("@rakazo/db"),
    ]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const marketplace = new PluginMarketplaceFixture(thirdParties.fetch);
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    // Scripted runs only: a real model would see a computer it could use in every spec.
    const userDevices = agentRuntime === "scripted" ? new UserDeviceEmulator() : undefined;
    const handles = await createApp({
      databaseUrl,
      modelConnectionFetch: createModelConnectionFixtureFetch(listPiCatalog()),
      prisma: undefined,
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
      connectors: [new DestinationEmulator()],
      pipedream,
      email,
      remoteConnectors: {
        fetch: marketplace.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      pluginRepoFetcher: marketplace.repo,
      pluginMarketplaceRead: marketplace.index,
      integrationsCatalogUrl: "https://catalog.example.test/",
      userDevices,
    });
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        if (new URL(request.url).pathname === "/__e2e/user-device-requests") {
          return Response.json(userDevices?.requests ?? [], {
            headers: { "cache-control": "no-store" },
          });
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@rakazo/web",
            "exec",
            "playwright",
            "test",
            ...(e2eSpec ? [e2eSpec] : []),
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
            ...(shard ? ["--shard", shard] : []),
          ],
          {
            ...process.env,
            CI: "1",
            DATABASE_URL: migrationUrl,
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      // The API connects as the runtime login, where such a call returns nothing.
      const unscoped = drainUnscopedDatabaseAccess();
      if (unscoped.length) {
        throw new Error(
          `Database access without a tenant or system context:\n\n${unscoped.join("\n\n")}`,
        );
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles, runAsSystem).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "novita" | "daytona" | "boat" | "boxd" | "instabox",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<ReturnType<typeof createApp>>;

async function managedComputers(handles: AppHandles, runAsSystem: typeof RunAsSystem) {
  if (!["e2b", "novita", "daytona", "boat", "boxd", "instabox"].includes(sandboxProvider))
    return [];
  // Outside a tenant or system context the runtime login reads no rows, and nothing is destroyed.
  return runAsSystem("e2e cleanup of real test sandboxes", () =>
    handles.prisma.computer.findMany({
      where: { providerRef: { not: null } },
      select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
    }),
  );
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
