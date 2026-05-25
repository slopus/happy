/**
 * Helpers for redacting secret-shaped fields out of log lines.
 *
 * Happy CLI writes debug logs to `~/.happy/logs/<timestamp>-pid-*.log` and
 * may forward the same lines over HTTP if a user has opted into
 * `DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING`. Any path that
 * serializes either `process.argv` (which can hold things like
 * `--claude-env ANTHROPIC_TOKEN=...`) or a user-supplied param object
 * (which can hold OAuth tokens, encryption keys, environment variables)
 * MUST go through one of these helpers first.
 */

/**
 * Case-insensitive: an env-var name or property name is treated as secret
 * if it contains any of these substrings.
 *
 * Trailing word boundaries are intentionally loose so `ANTHROPIC_TOKEN`,
 * `AUTH_HEADER`, `SECRET_KEY`, `OAUTH_TOKEN`, `accessToken`, `apiKey`,
 * `encryptionKey` all match.
 */
const SECRET_NAME_TOKENS = ['token', 'key', 'secret', 'auth', 'password', 'credential'];
export const SECRET_NAME_PATTERN = new RegExp(`(?:${SECRET_NAME_TOKENS.join('|')})`, 'i');

export const REDACTED = '[REDACTED]';

/**
 * Keys that should always be redacted regardless of whether they match
 * `SECRET_NAME_PATTERN` — e.g. `environmentVariables` contains free-form
 * user values that may themselves be secret.
 */
export const FORCE_REDACT_KEYS: ReadonlySet<string> = new Set([
  'encryptionKey',
  'environmentVariables',
]);

/**
 * Redact `KEY=VALUE` entries in a `process.argv`-shaped list when KEY looks
 * like a secret. `--claude-env ANTHROPIC_TOKEN=secret-xxx` is the canonical
 * case: the second arg arrives here as `ANTHROPIC_TOKEN=secret-xxx` and
 * gets rewritten to `ANTHROPIC_TOKEN=[REDACTED]`. Pure flags / positional
 * args without an `=` are passed through unchanged.
 */
export function redactArgvForLog(argv: readonly string[]): string[] {
  return argv.map((arg) => {
    const eqIdx = arg.indexOf('=');
    if (eqIdx <= 0) return arg;
    const key = arg.slice(0, eqIdx);
    if (SECRET_NAME_PATTERN.test(key)) {
      return `${key}=${REDACTED}`;
    }
    const value = arg.slice(eqIdx + 1);
    const innerEqIdx = value.indexOf('=');
    if (innerEqIdx <= 0) return arg;
    const innerKey = value.slice(0, innerEqIdx);
    if (!SECRET_NAME_PATTERN.test(innerKey)) return arg;
    return `${key}=${innerKey}=${REDACTED}`;
  });
}

/**
 * Recursively redact secret-named properties in an object so it can be
 * safely `JSON.stringify`'d for logging. The structure (keys, nesting,
 * array order) is preserved so debug logs stay useful; only the values of
 * secret-named keys are replaced with `[REDACTED]`. Non-plain values
 * (Date, Buffer, etc.) are returned unchanged.
 */
export function redactObjectForLog(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof RegExp) return value;
  if (Array.isArray(value)) return value.map(redactObjectForLog);
  // Avoid descending into typed arrays / Buffers — leave them as-is.
  if (ArrayBuffer.isView(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORCE_REDACT_KEYS.has(k) || SECRET_NAME_PATTERN.test(k)) {
      result[k] = REDACTED;
    } else {
      result[k] = redactObjectForLog(v);
    }
  }
  return result;
}
