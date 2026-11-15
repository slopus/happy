import type { CodexLiveCatalog } from "@rakazo/adapters";
import { mcpStdioRefusal, providerCatalogCache, validateBotModelChange } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { canonicalPiProviderId, ModelConnectInputSchema } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import { findModelCredential, Prisma, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isAdmin } from "./admins.js";
import type { AgentImportServices } from "./agent-import.js";
import type { createMcpServers } from "./mcp-servers.js";
import { mcpCredentialRecords, mcpStdioPolicy } from "./mcp-servers.js";
import type { createModelConnector } from "./model-credentials.js";
import { createImportedModelCredential, prepareModelCredential } from "./model-credentials.js";
import type { RouterDeps } from "./router.js";
import type { createRoutineAnnouncer } from "./routines.js";
import { assertRoutineSchedule, routineNextRunAt, routineRowData } from "./routines.js";

export function createAgentImportServices({
  deps,
  repos,
  codexCatalog,
  verifyModelConnection,
  botModelValidation,
  prepareMcpServer,
  insertMcpServer,
  announceRoutine,
}: {
  deps: RouterDeps;
  repos: ReturnType<typeof createRepos>;
  codexCatalog: CodexLiveCatalog;
  verifyModelConnection: ReturnType<typeof createModelConnector>["verifyModelConnection"];
  botModelValidation: (actor: Actor) => Parameters<typeof validateBotModelChange>[0];
  prepareMcpServer: ReturnType<typeof createMcpServers>["prepareMcpServer"];
  insertMcpServer: ReturnType<typeof createMcpServers>["insertMcpServer"];
  announceRoutine: ReturnType<typeof createRoutineAnnouncer>;
}) {
  type ImportKey = {
    credential: Parameters<typeof prepareModelCredential>[2];
    prepared: Awaited<ReturnType<typeof prepareModelCredential>>;
  };
  const agentImportServices: AgentImportServices<ImportKey> = {
    prisma: deps.prisma,
    // Serializable so the create-only key check cannot race a connection saved meanwhile.
    createBot: (actor, input) =>
      withTransactionRetry(() =>
        repos.createBot(actor, {
          ...input,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        }),
      ),
    hasModelConnection: async (actor, provider) =>
      Boolean(await findModelCredential(deps.prisma, actor, provider)),
    mcpCredentialValues: async (actor, server) => {
      const secret = await deps.prisma.secret.findFirst({
        where: { id: server.secretId, spaceId: actor.spaceId, userId: actor.userId },
      });
      if (!secret) return null;
      // A decrypt or parse error can quote the secret, so it is neither rethrown nor logged.
      try {
        return mcpCredentialRecords(
          JSON.parse(await deps.secrets.load(secret.ciphertext, { recordId: secret.id })),
        );
      } catch {
        getLogger().warn("imported mcp server credential could not be read", {
          "mcp.server.id": server.id,
        });
        return null;
      }
    },
    connectedProviders: async (actor, providers) => {
      const rows = await deps.prisma.userModelCredential.findMany({
        where: { userId: actor.userId },
        select: { provider: true },
      });
      const have = new Set(rows.map((row) => canonicalPiProviderId(row.provider)));
      return new Set(providers.filter((provider) => have.has(canonicalPiProviderId(provider))));
    },
    validateBotModel: async (actor, provider, modelId) => {
      const result = await validateBotModelChange(botModelValidation(actor), {
        userId: actor.userId,
        spaceId: actor.spaceId,
        provider,
        model: modelId,
        thinkingLevel: undefined,
        current: { provider: null, model: null },
      });
      return result.ok ? null : result.error;
    },
    stdioAllowed: async (actor) => {
      const admin = await isAdmin(deps, actor.userId);
      return (command) => admin && !mcpStdioRefusal(command, mcpStdioPolicy(deps));
    },
    prepareModelKey: async (actor, input, signal) => {
      const connect = ModelConnectInputSchema.parse({ ...input, credentialId: null });
      const { plaintext } = await verifyModelConnection(actor, connect, signal);
      const credential = {
        provider: input.provider,
        credentialId: null,
        plaintext,
        modelId: input.modelId,
        signal,
        keepExistingDefault: true,
      };
      return {
        credential,
        prepared: await prepareModelCredential(deps, actor, credential, codexCatalog),
      };
    },
    writeModelKey: async (tx, actor, key) => {
      const row = await createImportedModelCredential(tx, actor, key.credential, key.prepared);
      return row && { id: row.id, secretId: row.secretId, provider: row.provider };
    },
    afterModelKey: (provider) =>
      (deps.providerCatalog ?? providerCatalogCache).invalidate(canonicalPiProviderId(provider)),
    prepareMcpServer,
    insertMcpServer,
    findBot: async (actor, botId) =>
      (await repos.listBots(actor)).find((bot) => bot.id === botId) ?? null,
    assertRoutineSchedule,
    routineNextRunAt,
    routineRowData,
    announceRoutine,
    notifyThread: (threadId, seq) => deps.events.notify(threadId, seq),
  };
  return agentImportServices;
}
