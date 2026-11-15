/** Parse OpenRouter's credit-reservation error, never a model's generated text. */
export function affordableOpenRouterOutput(
  provider: string,
  errorMessage: string | undefined,
  currentLimit: number,
): number | undefined {
  if (
    provider !== "openrouter" ||
    !errorMessage ||
    errorMessage.length > 16_384 ||
    !/^402\b/.test(errorMessage)
  )
    return;
  if (!Number.isSafeInteger(currentLimit) || currentLimit < 1) return;
  try {
    const start = errorMessage.indexOf("{");
    if (start < 0) return;
    const parsed = JSON.parse(errorMessage.slice(start)) as {
      message?: string;
      metadata?: { limit_source?: string };
      error?: { message?: string; metadata?: { limit_source?: string } };
    };
    const error = parsed.error ?? parsed;
    if ((error.metadata ?? parsed.metadata)?.limit_source !== "openrouter_credits") return;
    // This fixed provider error reports the largest output reservation it can accept.
    const match = error.message?.match(
      /^This request requires more credits, or fewer max_tokens\. You requested up to (\d+) tokens, but can only afford (\d+)\./,
    );
    if (!match) return;
    const requested = Number(match[1]);
    const affordable = Number(match[2]);
    if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(affordable)) return;
    if (affordable < 1 || affordable >= requested || affordable >= currentLimit) return;
    return affordable;
  } catch {
    return;
  }
}
