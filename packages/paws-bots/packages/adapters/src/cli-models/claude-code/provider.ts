import type {
  Api,
  Model,
  Models,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider, lazyStream } from "@earendil-works/pi-ai";
import type { PersonalCliAccessCheck } from "../personal-access.js";
import { CLAUDE_CODE_PROVIDER_ID } from "./provider-id.js";

export { CLAUDE_CODE_PROVIDER_ID };

const CLAUDE_CODE_API = "claude-code-cli";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;

interface ClaudeCodeProviderOptions {
  modelId: string;
  accessCheck?: PersonalCliAccessCheck;
}

/** The CLI takes Anthropic's model ids, so Pi's card for the same id supplies the limits. */
export function claudeCodeModel(id: string, models: Models): Model<Api> {
  const card = models.getModel("anthropic", id);
  return {
    id,
    name: card?.name ?? id,
    api: CLAUDE_CODE_API,
    provider: CLAUDE_CODE_PROVIDER_ID,
    baseUrl: "",
    reasoning: card?.reasoning ?? true,
    ...(card?.thinkingLevelMap ? { thinkingLevelMap: card.thinkingLevelMap } : {}),
    input: card?.input ?? ["text", "image"],
    // Usage counts against the operator's own Claude plan, so Rakazo prices nothing: with no
    // positive rate, normalizePiUsage records the cost as unknown (null) rather than free.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: card?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: card?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export function claudeCodeProvider(models: Models, options: ClaudeCodeProviderOptions): Provider {
  const assertAllowed = async () => {
    const refusal = options.accessCheck
      ? await options.accessCheck()
      : "Claude Code runs only inside the Rakazo API and worker.";
    if (refusal) throw new Error(refusal);
  };
  const stream = (
    model: Model<Api>,
    context: TranscriptContext,
    streamOptions?: SimpleStreamOptions,
  ) =>
    lazyStream(model, async () => {
      const { streamClaudeCode } = await import("./stream.js");
      return streamClaudeCode(model, context, { ...streamOptions, assertAllowed });
    });
  return createProvider({
    id: CLAUDE_CODE_PROVIDER_ID,
    name: "Claude Code",
    auth: {
      apiKey: {
        name: "Claude Code sign-in on this server",
        // The CLI signs its own requests; Rakazo has no credential to resolve.
        resolve: async () => ({ auth: {}, source: "claude auth login" }),
      },
    },
    models: [claudeCodeModel(options.modelId, models)],
    api: { stream, streamSimple: stream },
  });
}

export function registerClaudeCodeProvider(
  models: MutableModels,
  options: ClaudeCodeProviderOptions,
): MutableModels {
  models.setProvider(claudeCodeProvider(models, options));
  return models;
}
