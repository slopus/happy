// `docker compose exec api node dist/cli/diagnostics.js`: a redacted report for a support issue.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentKeyProviderFromEnv, unwrapEnvFromKeyManager } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem } from "@rakazo/db";
import type { DiagnosticsInput } from "../diagnostics.js";
import { renderDiagnostics } from "../diagnostics.js";
import type { AppEnv } from "../env.js";
import { loadEnv } from "../env.js";

const RECENT_RUNS = 10;
const serverFields = {
  id: true,
  spaceId: true,
  userId: true,
  transport: true,
  enabled: true,
  allSpaces: true,
  availableIn: { select: { spaceId: true } },
  healthStatus: true,
  healthMessage: true,
  healthToolCount: true,
  healthCheckedAt: true,
} as const;

// Raw errors can carry connection strings or paths, so only the error's class is printed.
try {
  process.stdout.write(await report());
} catch (error) {
  const kind = error instanceof Error && /^\w+$/.test(error.name) ? error.name : "Error";
  process.stderr.write(`Diagnostics failed (${kind}). Run it in the api service.\n`);
  process.exitCode = 1;
}

async function report(): Promise<string> {
  await unwrapEnvFromKeyManager();
  const env = loadEnv();
  const { prisma, pool } = createDb(env.databaseUrl, { keyProvider: contentKeyProviderFromEnv() });
  try {
    return renderDiagnostics(await runAsSystem("diagnostics report", () => collect(env, prisma)));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function collect(env: AppEnv, prisma: PrismaClient): Promise<DiagnosticsInput> {
  const base = {
    env: {
      gitSha: env.gitSha,
      nodeEnv: env.nodeEnv,
      agentRuntime: env.agentRuntime,
      sandboxProvider: env.sandboxProvider,
      cloudAgentProvider: env.cloudAgentProvider,
      deploymentModelConfigured: env.deploymentModelConfigured,
      contentEncryption: env.contentEncryption,
      wakeupDriver: env.wakeupDriver,
      mcpStdioEnabled: env.mcpStdioEnabled,
      mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
      mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
      ticketBoardEnabled: env.ticketBoardEnabled,
      userDevicesEnabled: env.userDevicesEnabled,
      phoneCallsEnabled: env.phoneCallsEnabled,
      secretStore: process.env.SECRET_STORE?.trim() || "encrypted",
    },
    nodeVersion: process.version,
    bots: [],
    assignments: [],
    unassignedServers: [],
    runs: [],
  };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return { ...base, database: { reachable: false } };
  }
  const [bots, assignments, unassigned, runs, migrations] = await Promise.all([
    prisma.bot.findMany({ select: { id: true, spaceId: true, userId: true, archivedAt: true } }),
    prisma.botMcpServer.findMany({
      select: { botId: true, spaceId: true, userId: true, server: { select: serverFields } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.mcpServer.findMany({ where: { assignments: { none: {} } }, select: serverFields }),
    prisma.run.findMany({
      select: { id: true, botId: true, status: true, trigger: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: RECENT_RUNS,
    }),
    appliedMigrations(prisma),
  ]);
  const flatten = <T extends { availableIn: { spaceId: string }[] }>(server: T) => ({
    ...server,
    availableIn: server.availableIn.map((space) => space.spaceId),
  });
  return {
    ...base,
    database: {
      reachable: true,
      migrationsInImage: readdirSync(
        fileURLToPath(new URL("../../../../packages/db/prisma/migrations", import.meta.url)),
        { withFileTypes: true },
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
      ...migrations,
    },
    bots: bots.map(({ archivedAt, ...bot }) => ({ ...bot, archived: archivedAt !== null })),
    assignments: assignments.map((row) => ({ ...row, server: flatten(row.server) })),
    unassignedServers: unassigned.map(flatten),
    runs,
  };
}

/** The runtime login normally has no grant on the migration table; that is reported, not fatal. */
async function appliedMigrations(prisma: PrismaClient) {
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string; failed: boolean }>>`
      SELECT migration_name AS name, finished_at IS NULL AS failed
      FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
    return {
      appliedMigrations: rows.filter((row) => !row.failed).map((row) => row.name),
      failedMigrations: rows.filter((row) => row.failed).length,
    };
  } catch {
    return {};
  }
}
