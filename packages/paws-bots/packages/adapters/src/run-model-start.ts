import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { isModelCredentialRejected } from "@rakazo/adapter-kit";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { MISSING_MODEL_RUN_ERROR, MODEL_ACCESS_REQUIRED_RUN_ERROR } from "@rakazo/core";
import { memberHasModelAccess } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { HostedModelCreditsRequiredError } from "./model-credit-observer.js";
import type { DeploymentModelDefaults } from "./model-roles.js";
import { effectiveModelRole } from "./model-roles.js";
import { isRetiredModelCredentialError } from "./pi-oauth.js";
import type { restoreComputerModels } from "./pi-runtime-computer-mode.js";
import {
  isTerminalModelSetupError,
  modelCreditBillingEnabled,
  resolveConnectedModelKey,
  resolveModelKey,
} from "./run-model.js";

/** The run's backup models, loaded once, and the first of them that starts. */
export function runModelBackups(
  deps: ExecutorDeps,
  run: { id: string; userId: string; spaceId: string; modelPinned: boolean },
  defaults: DeploymentModelDefaults,
  scripted: boolean,
  registerSecrets: (values: string[]) => void,
) {
  let backupChoices: Promise<ModelRoleChoice[]> | undefined;
  const load = () =>
    (backupChoices ??= scripted
      ? Promise.resolve([])
      : effectiveModelRole(deps.prisma, run, "main", defaults).then(
          (role) => role.backups,
          (error: unknown) => {
            getLogger().warn("Backup models could not be loaded", { runId: run.id, error });
            return [];
          },
        ));
  // Backups that could not start here are not offered again once the model runs.
  const unavailable = new Set<ModelRoleChoice>();
  // A main model with no connection, or whose provider refused its sign-in, runs on the
  // first backup that starts. A pinned run asked for its model and keeps it.
  const startOnBackup = async () => {
    if (run.modelPinned) return undefined;
    for (const choice of await load()) {
      try {
        const backup = await resolveConnectedModelKey(
          deps,
          run,
          choice.provider,
          choice.modelId,
          registerSecrets,
          true,
          choice.credentialId,
        );
        getLogger().warn("model.primary_unavailable.backup_used", {
          runId: run.id,
          "model.provider": choice.provider,
          "model.id": choice.modelId,
        });
        return {
          provider: choice.provider,
          id: choice.modelId,
          credential: backup.credential,
          thinkingLevel: (choice.thinkingLevel ??
            null) as AgentRunRequest["model"]["thinkingLevel"],
          resolved: backup.resolved,
        };
      } catch {
        // Resolver errors can carry credential details, so only the outcome is kept.
        unavailable.add(choice);
      }
    }
    return undefined;
  };
  return { load, unavailable, startOnBackup };
}

/**
 * The model a run starts on: its selected model, else the first backup that starts. Returns the
 * failure to record on the run when none can start; a credential refusal worth retrying throws.
 */
export async function startRunModel(
  deps: ExecutorDeps,
  run: { userId: string; spaceId: string },
  selected: {
    provider: string | null | undefined;
    id: string | null | undefined;
    credential: Awaited<ReturnType<typeof resolveConnectedModelKey>>["credential"];
    thinkingLevel: AgentRunRequest["model"]["thinkingLevel"];
  },
  pinned: Awaited<ReturnType<typeof restoreComputerModels>>["main"] | undefined,
  backups: ReturnType<typeof runModelBackups>,
  registerSecrets: (values: string[]) => void,
) {
  const modelAccessDenied = async () =>
    (await modelCreditBillingEnabled(deps)) && !(await memberHasModelAccess(deps.prisma, run));
  let start: Awaited<ReturnType<typeof backups.startOnBackup>>;
  let primaryFailure = { message: MISSING_MODEL_RUN_ERROR, accountFailure: true };
  let retryPrimary: unknown;
  if (selected.provider && selected.id) {
    if (await modelAccessDenied()) {
      return { failure: { message: MODEL_ACCESS_REQUIRED_RUN_ERROR, accountFailure: true } };
    }
    try {
      start = {
        provider: selected.provider,
        id: selected.id,
        credential: selected.credential,
        thinkingLevel: selected.thinkingLevel,
        resolved: pinned
          ? {
              ...pinned,
              apiKey: pinned.apiKey,
              callObserver: pinned.callObserver,
              oauth: pinned.oauth?.credential,
              persistOAuth: pinned.oauth?.persist,
              refreshOAuth: pinned.oauth?.refresh,
              retireOAuth: pinned.oauth?.retire,
              redact: [],
            }
          : await resolveModelKey(
              deps,
              run.userId,
              run.spaceId,
              selected.credential,
              selected.provider,
              selected.id,
              registerSecrets,
            ),
      };
    } catch (error) {
      // An incompatible saved model or a dead (already retired) credential is a
      // configuration error: record it on the run rather than retrying setup.
      const terminal = isTerminalModelSetupError(error);
      if (!terminal && !isModelCredentialRejected(error)) throw error;
      primaryFailure = {
        message: error instanceof Error ? error.message : "Connect the provider again.",
        accountFailure:
          error instanceof HostedModelCreditsRequiredError || isRetiredModelCredentialError(error),
      };
      if (!terminal) retryPrimary = error;
    }
  } else if (await modelAccessDenied()) {
    return { failure: { message: MISSING_MODEL_RUN_ERROR, accountFailure: true } };
  }
  start ??= await backups.startOnBackup();
  if (!start) {
    if (retryPrimary) throw retryPrimary;
    return { failure: primaryFailure };
  }
  return { start };
}
