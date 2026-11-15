import { reducedContextWindow } from "./groq-request-budget.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

const REPORTED_WINDOW = [
  // vLLM and OpenRouter
  /maximum context length is (\d+) tokens/i,
  // SGLang, Together and LiteLLM: "the model's context length (N tokens)" or "of N tokens"
  /model'?s (?:maximum )?context length (?:of )?\(?(\d+)/i,
  // llama.cpp
  /"n_ctx"\s*:\s*(\d+)/,
  // LM Studio
  /loaded with context length of only (\d+) tokens/i,
];

/**
 * The context window an OpenAI-compatible server reports when it rejects an oversized request.
 * Such connections fall back to a large default window when the server reports none up front.
 */
export function reportedContextWindow(
  provider: string,
  errorMessage: string | undefined,
  currentWindow: number,
): number | undefined {
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID || !errorMessage || errorMessage.length > 16_384)
    return;
  for (const pattern of REPORTED_WINDOW) {
    const limit = Number(errorMessage.match(pattern)?.[1]);
    if (Number.isSafeInteger(limit) && limit >= 1)
      return reducedContextWindow(limit, currentWindow);
  }
  return;
}
