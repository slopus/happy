import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// Google's documented marker for function calls whose original signature is unavailable:
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#faqs
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/**
 * Gemini rejects a request when the first function call of a model step has no thought
 * signature. Pi replays a signature only for calls the same provider, API and model made,
 * and only when it is valid base64, so transferred history (another model, a backup model,
 * a restored turn on a different API) and any call whose signature was lost reach the wire
 * unsigned. Real signatures are kept; only the first unsigned call of a step is marked.
 * Later calls in a parallel batch legitimately carry no signature and stay as they are.
 */
export function withGoogleToolHistory(
  model: Model<Api>,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  if (model.api !== "google-generative-ai" && model.api !== "google-vertex") return options;
  if (!/gemini/i.test(model.id)) return options;
  return {
    ...options,
    async onPayload(payload, requestedModel) {
      if (isRecord(payload) && Array.isArray(payload.contents)) {
        for (const content of payload.contents) {
          if (!isRecord(content) || content.role !== "model" || !Array.isArray(content.parts))
            continue;
          const firstCall = content.parts.find(
            (part): part is Record<string, unknown> =>
              isRecord(part) && isRecord(part.functionCall),
          );
          if (firstCall && !firstCall.thoughtSignature)
            firstCall.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
        }
      }
      const replacement = await options.onPayload?.(payload, requestedModel);
      return replacement === undefined ? payload : replacement;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
