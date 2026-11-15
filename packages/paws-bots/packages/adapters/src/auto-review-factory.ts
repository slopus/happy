import type { AutoReviewProvider, AutoReviewRequest, AutoReviewResult } from "@rakazo/adapter-kit";
import type { LlmAutoReviewOptions } from "./auto-review.js";
import {
  autoReviewMinConfidence,
  autoReviewTimeoutMs,
  DEFAULT_JEV_MODEL,
  LlmAutoReviewProvider,
  resolveAutoReviewProviderKind,
  typesafeApiKey,
} from "./auto-review.js";
import { JevAutoReviewProvider } from "./jev-auto-review.js";
import { ScriptedAutoReviewProvider } from "./scripted-auto-review.js";

export type CreateAutoReviewProviderOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  minConfidence?: number;
  llm?: LlmAutoReviewOptions;
  scripted?: AutoReviewResult | ((request: AutoReviewRequest) => AutoReviewResult);
};

/**
 * Construct the Auto Review adapter selected by `RAKAZO_AUTO_REVIEW_PROVIDER`.
 * `jev` needs TYPESAFE_API_KEY; `llm` wraps the existing JSON judge; `scripted` is offline.
 */
export function createAutoReviewProvider(
  kind?: string,
  options: CreateAutoReviewProviderOptions = {},
): AutoReviewProvider {
  const env = options.env ?? process.env;
  switch (kind ?? resolveAutoReviewProviderKind(env)) {
    case "jev": {
      const apiKey = options.apiKey ?? typesafeApiKey(env);
      if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
      return new JevAutoReviewProvider({
        apiKey,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs ?? autoReviewTimeoutMs(env),
        model: options.model ?? env.RAKAZO_AUTO_REVIEW_MODEL?.trim() ?? DEFAULT_JEV_MODEL,
        minConfidence: options.minConfidence ?? autoReviewMinConfidence(env),
      });
    }
    case "scripted":
      return new ScriptedAutoReviewProvider(options.scripted);
    case "llm":
      if (!options.llm) throw new Error("LLM auto-review requires a runtime checker");
      return new LlmAutoReviewProvider(options.llm);
    default:
      throw new Error(`Unknown auto-review provider "${kind}". Use jev | llm | scripted.`);
  }
}
