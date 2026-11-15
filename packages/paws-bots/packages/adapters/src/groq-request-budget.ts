/** Groq's 413 token-rate contract describes a per-request ceiling for this account. */
export function groqRequestContextWindow(
  provider: string,
  errorMessage: string | undefined,
  currentWindow: number,
): number | undefined {
  if (
    provider !== "groq" ||
    !errorMessage ||
    errorMessage.length > 16_384 ||
    !/^413\b/.test(errorMessage)
  )
    return;
  try {
    const start = errorMessage.indexOf("{");
    if (start < 0) return;
    const parsed = JSON.parse(errorMessage.slice(start)) as {
      code?: string;
      type?: string;
      message?: string;
      error?: { code?: string; type?: string; message?: string };
    };
    const error = parsed.error ?? parsed;
    if (error.code !== "rate_limit_exceeded" || error.type !== "tokens") return;
    const match = error.message?.match(
      /on tokens per minute \(TPM\): Limit (\d+), Requested (\d+),/,
    );
    if (!match) return;
    const limit = Number(match[1]);
    const requested = Number(match[2]);
    if (
      !Number.isSafeInteger(limit) ||
      !Number.isSafeInteger(requested) ||
      requested <= limit ||
      limit < 1
    )
      return;
    return reducedContextWindow(limit, currentWindow);
  } catch {
    return;
  }
}

/** Leave room for provider tokenizer differences; output retains its usual quarter-window cap. */
export function reducedContextWindow(limit: number, currentWindow: number): number | undefined {
  const window = Math.floor(limit * 0.85);
  return window > 0 && window < currentWindow ? window : undefined;
}
