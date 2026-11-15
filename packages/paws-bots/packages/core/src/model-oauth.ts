import { abortableDelay } from "./async.js";
import { isRetryableError } from "./retry-policy.js";

export type ModelOAuthCompletion =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; error: string };

type OAuthControllerRef = { current: AbortController | null };

export function cancelModelOAuthAttempt(ref: OAuthControllerRef, reset: () => void) {
  const controller = ref.current;
  controller?.abort();
  if (ref.current !== controller) return;
  ref.current = null;
  reset();
}

export function finishModelOAuthAttempt(
  ref: OAuthControllerRef,
  controller: AbortController,
  resetBusy: () => void,
) {
  if (ref.current !== controller) return;
  ref.current = null;
  resetBusy();
}

export async function waitForModelOAuthCompletion(
  complete: () => Promise<ModelOAuthCompletion>,
  options: { signal?: AbortSignal; attempts?: number; pollIntervalMs?: number } = {},
): Promise<{ status: "ready" }> {
  const attempts = options.attempts ?? 180;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    let result: ModelOAuthCompletion;
    try {
      result = await complete();
    } catch (error) {
      throwIfAborted(options.signal);
      if (!isRetryableError(error)) throw error;
      // A failed status read does not mean the sign-in itself failed.
      result = { status: "pending" };
    }
    throwIfAborted(options.signal);
    if (result.status === "ready") return result;
    if (result.status === "error") throw new Error(result.error);
    if (attempt < attempts) await abortableDelay(pollIntervalMs, options.signal);
  }
  throw new Error("Sign-in timed out. Try again.");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("OAuth polling cancelled");
}
