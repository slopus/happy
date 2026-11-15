import type { AgentRunModel } from "@rakazo/adapter-kit";
import { isModelCredentialRejected } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { appliedModelRole } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { computerTarget } from "./pi-runtime-computer-mode.js";
import { isTerminalModelSetupError } from "./run-model.js";
import { restoreTurnCheckpoint } from "./turn-checkpoint.js";

type Resolve = (
  provider: string,
  id: string,
  connectionId?: string,
  thinkingLevel?: string,
) => Promise<AgentRunModel>;

/**
 * The member's computer-use model: the first of their choices that computer mode can run.
 * None set, or none usable, leaves the main model working the screen itself.
 */
export async function resolveComputerRunModel(
  deps: {
    prisma: PrismaClient;
    resolve: Resolve;
    /** The connection that serves a choice saved without one. */
    connectionFor: (provider: string, modelId: string) => Promise<string | undefined>;
  },
  scope: { userId: string; spaceId: string },
  main: AgentRunModel,
): Promise<AgentRunModel | undefined> {
  // A paused turn pins both identities by connection, so a hosted main model cannot switch.
  if (!main.connectionId) return undefined;
  const { primary, backups } = await appliedModelRole(deps.prisma, scope, "computer");
  for (const choice of primary ? [primary, ...backups] : []) {
    try {
      const connectionId =
        choice.credentialId ?? (await deps.connectionFor(choice.provider, choice.modelId));
      if (!connectionId) continue;
      if (
        choice.provider === main.provider &&
        choice.modelId === main.id &&
        connectionId === main.connectionId
      )
        return undefined;
      const model = await deps.resolve(
        choice.provider,
        choice.modelId,
        connectionId,
        choice.thinkingLevel ?? undefined,
      );
      // The same check computer mode runs, so a model it would refuse never breaks the run.
      computerTarget(model);
      return model;
    } catch (error) {
      getLogger().warn("computer_model.unavailable", {
        "model.provider": choice.provider,
        "error.message": error instanceof Error ? error.message : String(error),
      });
    }
  }
  return undefined;
}

const LOST_PIN_MESSAGES = new Set([
  "Pinned computer mode model is unavailable",
  "Computer model checkpoint requires its pinned connection",
  "Backup model credential is no longer available",
]);

export const PINNED_COMPUTER_MODEL_LOST_RUN_ERROR =
  "A model this paused task was using is no longer connected, so it cannot continue. Reconnect the account or start the task again.";

/** A paused computer turn's model or account is gone for good, not briefly unreachable. */
export function isLostPinnedModel(error: unknown): boolean {
  return (
    isTerminalModelSetupError(error) ||
    isModelCredentialRejected(error) ||
    (error instanceof Error && LOST_PIN_MESSAGES.has(error.message))
  );
}

/** A stored checkpoint is authority for its two identities, not for arbitrary connections. */
export function computerCheckpointResolver(
  blob: string | undefined,
  main: AgentRunModel,
  resolve: Resolve,
) {
  if (!blob) return undefined;
  // Legacy checkpoint compatibility/replay stays with the executor's existing policy.
  let envelope: unknown;
  try {
    envelope = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (!envelope || typeof envelope !== "object" || !("computerMode" in envelope)) return undefined;
  const state = restoreTurnCheckpoint(blob, main).computerMode;
  if (!state) return undefined;
  const has = (provider: string, id: string, connectionId?: string) =>
    [state.main, state.computer].some(
      (pin) => pin.provider === provider && pin.id === id && pin.connectionId === connectionId,
    );
  const resolver = async (provider: string, id: string, connectionId?: string) => {
    const pin = [state.main, state.computer].find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.id === id &&
        candidate.connectionId === connectionId,
    );
    if (!pin || !connectionId)
      throw new Error("Computer model checkpoint requires its pinned connection");
    const model = await resolve(provider, id, connectionId, pin.thinkingLevel ?? undefined);
    if (
      model.connectionId !== connectionId ||
      model.provider !== provider ||
      model.id !== id ||
      (model.oauth ? "oauth" : "api-key") !== pin.auth
    )
      throw new Error("Pinned computer mode model is unavailable");
    return model;
  };
  return Object.assign(resolver, {
    has,
    hasModel: (provider: string, id: string) =>
      [state.main, state.computer].some((pin) => pin.provider === provider && pin.id === id),
  });
}
