import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentRunModel, AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import type { RuntimeModelTarget } from "./pi-runtime-models.js";
import {
  cardOutputCeiling,
  modelForCompletion,
  resolveRuntimeModel,
  sameModelTarget,
} from "./pi-runtime-models.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";
import type { ComputerModeCheckpoint, ComputerModeSelection } from "./turn-checkpoint.js";

export const COMPUTER_MODE_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "open_path",
  "launch_app",
  "request_takeover",
  "user_computer_observe",
  "user_computer_act",
]);

export function computerSelection(config: AgentRunModel): ComputerModeSelection {
  return {
    provider: config.provider,
    id: config.id,
    connectionId: config.connectionId,
    auth: config.oauth ? "oauth" : "api-key",
    thinkingLevel: config.thinkingLevel,
  };
}

function validSelection(value: ComputerModeSelection): boolean {
  return Boolean(
    value &&
      typeof value.provider === "string" &&
      value.provider &&
      typeof value.id === "string" &&
      value.id &&
      (value.connectionId === undefined || typeof value.connectionId === "string") &&
      (value.auth === "oauth" || value.auth === "api-key") &&
      (value.thinkingLevel == null ||
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)),
  );
}

/** Resolve pinned identities through the caller's authenticated resolver, never saved credentials. */
export async function restoreComputerModels(
  request: Pick<AgentRunRequest, "resolveFallbackModel" | "resolveModel">,
  state: ComputerModeCheckpoint,
) {
  if (
    state.version !== 1 ||
    !["main", "computer"].includes(state.mode) ||
    !validSelection(state.main) ||
    !validSelection(state.computer)
  )
    throw new Error("Unsupported computer mode checkpoint");
  const resolve = async (selection: ComputerModeSelection) => {
    const config = request.resolveFallbackModel
      ? await request.resolveFallbackModel(selection.provider, selection.id, selection.connectionId)
      : !selection.connectionId && request.resolveModel
        ? await request.resolveModel(selection.provider, selection.id)
        : undefined;
    if (
      !config ||
      !sameModelTarget(config, selection) ||
      computerSelection(config).auth !== selection.auth
    )
      throw new Error("Pinned computer mode model is unavailable");
    return { ...config, thinkingLevel: selection.thinkingLevel };
  };
  return { main: await resolve(state.main), computer: await resolve(state.computer) };
}

export function computerTarget(config: AgentRunModel): RuntimeModelTarget {
  // Explicit configuration only: never borrow the main role's or environment credentials.
  if (!config.oauth && !config.apiKey && config.provider !== "openai-compatible")
    throw new Error("Computer model requires an explicitly authenticated configuration");
  const selected = resolveRuntimeModel(config);
  if (!selected.model) throw new Error("Computer model is unavailable");
  if (!selected.model.input.includes("image") || config.acceptsImages === false)
    throw new Error("Computer model must support image input");
  return {
    config: { ...config, thinkingLevel: config.thinkingLevel ?? "medium" },
    models: selected.models,
    model: modelForCompletion(selected.model, config.maxTokens),
    cardMaxTokens: cardOutputCeiling(selected.model),
    apiKey: selected.apiKey,
    credentials: selected.credentials,
  };
}

export function computerTransitionTool(
  mode: "main" | "computer",
  transition: () => void | Promise<void>,
  signal: AbortSignal,
): AgentTool {
  const entering = mode === "main";
  const field = entering ? "goal" : "summary";
  const definition: ConnectorTool = {
    name: entering ? "enter_computer_mode" : "leave_computer_mode",
    description: entering
      ? "Hand off a concrete GUI goal to computer mode before any browser or desktop action. Call this alone; computer mode continues in the same run."
      : "Finish computer work and return a summary to the main model in this same run. Call this alone.",
    inputSchema: {
      type: "object",
      properties: { [field]: { type: "string", minLength: 1 } },
      required: [field],
      additionalProperties: false,
    },
    readOnly: true,
  };
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: parametersFor(definition),
    executionMode: "sequential",
    execute: async (_id, args) => {
      signal.throwIfAborted();
      await transition();
      return {
        content: [{ type: "text", text: String((args as Record<string, unknown>)[field]) }],
        details: {},
      };
    },
  };
}
