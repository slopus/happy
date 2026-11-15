// Provider wording for a sandbox that no longer exists, for errors that lost their name.
const SANDBOX_GONE_MESSAGE = /sandbox [^:]{0,60}not found|sandbox [^:]{0,60}does not exist/i;
// The same words from a live sandbox: a missing binary or a missing file inside it.
const SHELL_MISSING_TARGET = /command not found|no such file|^path .* not found/i;

/**
 * Only provider evidence of sandbox loss permits automatic replacement. Adapters report it by
 * throwing an error named `SandboxNotFoundError`.
 */
export function isSandboxGoneError(error: unknown): boolean {
  if (isSandboxUnsafeStopError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (SHELL_MISSING_TARGET.test(message)) return false;
  if (SANDBOX_GONE_MESSAGE.test(message)) return true;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxNotFoundError") return true;
  }
  return false;
}

/** An error `isSandboxGoneError` recognizes, so callers replace the computer. */
export function sandboxNotFoundError(message: string, options?: ErrorOptions): Error {
  const error = new Error(message, options);
  error.name = "SandboxNotFoundError";
  return error;
}

/** A computer whose system cannot start programs, reported as `SandboxDamagedError`. */
export function isSandboxDamagedError(error: unknown): boolean {
  if (isSandboxUnsafeStopError(error)) return false;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxDamagedError") return true;
  }
  return false;
}

/** The provider cannot confirm that a command or computer stopped; automatic resume is unsafe. */
export class SandboxUnsafeStopError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "SandboxUnsafeStopError";
  }
}

export function isSandboxUnsafeStopError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.name === "SandboxUnsafeStopError") return true;
  }
  return false;
}
