import { abortableDelay } from "@rakazo/core";

/** Delay before the setup focus card for a non-first bot. */
export const FOCUS_PROMPT_DELAY_MS = 10_000;

/**
 * Schedule posting the focus choice card. First bot shows immediately; later
 * bots wait so the user can type freely. Abort the signal to cancel when the
 * user has already engaged (sent a message, dismissed, or left the thread).
 */
export async function scheduleFocusPrompt(options: {
  immediate: boolean;
  signal: AbortSignal;
  prompt: () => Promise<void>;
  /** True while a send is in flight so the delay cannot post over it. */
  shouldSkip?: () => boolean;
}): Promise<"prompted" | "cancelled"> {
  if (options.signal.aborted) return "cancelled";
  const delayMs = options.immediate ? 0 : FOCUS_PROMPT_DELAY_MS;
  try {
    await abortableDelay(delayMs, options.signal);
  } catch {
    return "cancelled";
  }
  if (options.signal.aborted || options.shouldSkip?.()) return "cancelled";
  await options.prompt();
  return options.signal.aborted ? "cancelled" : "prompted";
}
