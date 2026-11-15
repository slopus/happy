import type { Context } from "@earendil-works/pi-ai";
import type { ContextBudget } from "./context-selection.js";
import { estimateContextTokens } from "./context-selection.js";

/**
 * Provider-neutral estimate for an unknown tokenizer, including tool schemas and
 * message framing. Image blocks use the adapter's dimension-based planning estimate
 * when one is supplied and a serialized byte count otherwise.
 */
export function estimateModelContextTokens(
  context: Context,
  imageTokens?: ContextBudget["imageTokens"],
): number {
  return estimateContextTokens(context, imageTokens) + 240;
}
