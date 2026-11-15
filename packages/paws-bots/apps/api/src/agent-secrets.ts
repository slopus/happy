import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import {
  forgetBotSecret,
  getBotSecretMetadata,
  listBotSecretMetadata,
  storeBotSecret,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  AGENT_SECRET_NAME_PATTERN,
  BotSecretAuth,
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { requireSpaceOwner } from "@rakazo/db";
import { mapBotSecretInputError } from "./routes/bots.js";

type AgentSecretDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
};

/**
 * Space environment variables now live in the vault as command variables, so these routes are
 * kept for callers that predate it. A variable is addressed by its vault name, which is also its
 * id here, and acts on the vault this Space uses.
 */
function vaultScope(actor: Actor) {
  return { userId: actor.userId, spaceId: actor.spaceId };
}

function agentSecretDto(row: { name: string; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.name,
    name: commandVariableName(row.name),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAgentSecrets(deps: AgentSecretDeps, actor: Actor) {
  await requireSpaceOwner(deps.prisma, actor);
  const rows = await listBotSecretMetadata(deps.prisma, vaultScope(actor));
  return rows
    .filter((row) => BotSecretAuth.safeParse(row.auth).data?.type === "command")
    .filter((row) => {
      const variable = commandVariableName(row.name);
      return !commandVariableProblem(variable) && AGENT_SECRET_NAME_PATTERN.test(variable);
    })
    .map(agentSecretDto);
}

export async function putAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  input: { name: string; value: string },
) {
  await requireSpaceOwner(deps.prisma, actor);
  // The vault name that exports this variable: an existing one (`netbird-setup-key` exports
  // NETBIRD_SETUP_KEY), else the variable lower-cased. A vault name starts with a letter, so a
  // variable that starts with an underscore has none.
  const existing = (await listBotSecretMetadata(deps.prisma, vaultScope(actor))).find(
    (row) =>
      BotSecretAuth.safeParse(row.auth).data?.type === "command" &&
      commandVariableName(row.name) === input.name,
  );
  const name = existing?.name ?? input.name.toLowerCase();
  if (!BotSecretName.safeParse(name).success) {
    throw new ORPCError("BAD_REQUEST", { message: "Variable names must start with a letter" });
  }
  let row: Awaited<ReturnType<typeof getBotSecretMetadata>>;
  try {
    row = await storeBotSecret({
      prisma: deps.prisma,
      secretStore: deps.secrets,
      scope: vaultScope(actor),
      destination: { name, origin: "", auth: { type: "command" } },
      plaintext: input.value,
    });
  } catch (error) {
    throw mapBotSecretInputError(error);
  }
  if (!row) throw new ORPCError("CONFLICT", { message: "Variable was not saved" });
  return agentSecretDto(row);
}

export async function deleteAgentSecret(
  deps: AgentSecretDeps,
  actor: Actor,
  id: string,
): Promise<{ ok: true }> {
  await requireSpaceOwner(deps.prisma, actor);
  const scope = vaultScope(actor);
  const row = await getBotSecretMetadata(deps.prisma, scope, id);
  if (BotSecretAuth.safeParse(row?.auth).data?.type !== "command") {
    throw new ORPCError("NOT_FOUND");
  }
  await forgetBotSecret(deps.prisma, scope, id);
  return { ok: true };
}
