import type { SecretStore } from "@rakazo/adapter-kit";
import { lockMcpOAuthMaterial, persistPreparedSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { serverSecretSpace } from "./availability.js";
import type { McpSecretMaterial } from "./mcp-material.js";
import { legacyMcpArgs } from "./mcp-material.js";

/**
 * Moves stdio arguments still held in plaintext into each server's encrypted secret.
 * A server changed meanwhile is skipped as concurrent; its save already moved them. Rerun-safe,
 * so every API instance runs it at startup, and a server that fails is logged and left for the next.
 */
export async function moveMcpArgsIntoSecrets(
  prisma: PrismaClient,
  secrets: SecretStore,
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
) {
  const signal = options.signal ?? new AbortController().signal;
  const counts = { moved: 0, planned: 0, concurrent: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const rows = await prisma.mcpServer.findMany({
      where: { NOT: { args: { equals: [] } }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: 100,
    });
    for (const row of rows) {
      if (options.dryRun) {
        counts.planned++;
        continue;
      }
      try {
        const secret = row.secretId
          ? await prisma.secret.findUnique({ where: { id: row.secretId } })
          : null;
        const material: McpSecretMaterial = secret
          ? parseMaterial(await secrets.load(secret.ciphertext, { recordId: secret.id, signal }))
          : {};
        material.args ??= legacyMcpArgs(row.args);
        const stored = await secrets.put(JSON.stringify(material), {
          operationId: "mcp-args-migration",
          traceId: "mcp-args-migration",
          spaceId: row.spaceId,
          userId: row.userId,
          signal,
        });
        const moved = await persistPreparedSecret(prisma, secrets, stored, () =>
          prisma.$transaction(async (tx) => {
            await lockMcpOAuthMaterial(tx, row.id);
            const current = await tx.mcpServer.findUnique({ where: { id: row.id } });
            const currentSecret = current?.secretId
              ? await tx.secret.findUnique({ where: { id: current.secretId } })
              : null;
            if (
              !current ||
              current.revision !== row.revision ||
              current.secretId !== row.secretId ||
              currentSecret?.ciphertext !== secret?.ciphertext
            )
              return false;
            await tx.secret.create({
              data: {
                id: stored.id,
                userId: row.userId,
                spaceId: secret ? secret.spaceId : await serverSecretSpace(tx, current),
                kind: "mcp",
                ciphertext: stored.ciphertext,
              },
            });
            await tx.mcpServer.update({
              where: { id: row.id },
              data: {
                args: [],
                hasArgs: (material.args?.length ?? 0) > 0,
                secretId: stored.id,
              },
            });
            if (secret) await tx.secret.deleteMany({ where: { id: secret.id } });
            return true;
          }),
        );
        counts[moved ? "moved" : "concurrent"]++;
      } catch (error) {
        signal.throwIfAborted();
        counts.failed++;
        getLogger().error("mcp server arguments move failed", error, { mcpServerId: row.id });
      }
    }
    if (rows.length < 100) return counts;
    cursor = rows.at(-1)?.id;
  }
}

/** Parse and shape errors would quote the decrypted text, so neither reaches the log. */
function parseMaterial(text: string): McpSecretMaterial {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {}
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Stored MCP credentials are not a JSON object");
  return value as McpSecretMaterial;
}
