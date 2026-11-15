export const DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const MAX_SANDBOX_COMMAND_TIMEOUT_MS = 60 * 60_000;

export function sandboxCommandTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = Number(env.SANDBOX_COMMAND_TIMEOUT_MS);
  return validSandboxCommandTimeout(configured) ? configured : DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS;
}

export function boundedSandboxCommandTimeoutMs(
  requested: number | undefined,
  fallback?: number,
): number {
  if (validSandboxCommandTimeout(requested)) return requested;
  if (fallback === undefined) return sandboxCommandTimeoutMs();
  return validSandboxCommandTimeout(fallback) ? fallback : DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS;
}

function validSandboxCommandTimeout(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SANDBOX_COMMAND_TIMEOUT_MS
  );
}
