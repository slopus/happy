import {
  COMPUTER_ALLOWANCE_USED_ERROR,
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_RATE_LIMIT_ERROR,
} from "@rakazo/contracts";

/** The sandbox provider refused the request because an account rate limit or quota was hit. */
export class SandboxRateLimitError extends Error {
  readonly code = "SANDBOX_RATE_LIMITED";
  /** How long the provider asked to wait before trying again, when it said. */
  readonly retryAfterMs: number | undefined;
  constructor(options?: { cause?: unknown; retryAfterMs?: number }) {
    super(COMPUTER_RATE_LIMIT_ERROR, options);
    this.name = "SandboxRateLimitError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * The sandbox supervisor refused a page browser request while parsing it, before anything was
 * sent to the computer, so nothing ran. It is the only refusal that proves that.
 */
export const INVALID_BROWSER_REQUEST = "invalid_browser_request";
export class SandboxRequestRejectedError extends Error {
  readonly code = INVALID_BROWSER_REQUEST;
  constructor() {
    super("The page browser could not accept this request, so nothing was done.");
    this.name = "SandboxRequestRejectedError";
  }
}

/** The organization spent this month's computer allowance, so no computer that bills starts. */
export class SandboxAllowanceUsedError extends Error {
  readonly code = "SANDBOX_ALLOWANCE_USED";
  constructor() {
    super(COMPUTER_ALLOWANCE_USED_ERROR);
    this.name = "SandboxAllowanceUsedError";
  }
}

/**
 * The provider could not be reached, failed on its side, or gave up waiting for the sandbox to
 * answer. It is not resent; background work skips this attempt and tries again later.
 */
export class SandboxUnresponsiveError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxUnresponsiveError";
  }
}

/**
 * The deployment's own provider account refused the request, for example because it is unpaid.
 * Only the operator can fix it, so users get a neutral message and the cause stays in the logs.
 */
export class SandboxProviderAccountError extends SandboxUnresponsiveError {
  readonly code = "SANDBOX_PROVIDER_ACCOUNT";
  constructor(options?: { cause?: unknown }) {
    super(COMPUTER_PROVIDER_UNAVAILABLE_ERROR, options);
    this.name = "SandboxProviderAccountError";
  }
}

/** The provider accepted the start but did not bring the computer up in time; a retry may work. */
export class SandboxUnavailableError extends Error {
  readonly code = "SANDBOX_UNAVAILABLE";
  constructor(options?: { cause?: unknown }) {
    super("The computer did not start. Try again.", options);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * The provider is down, slow, or limiting requests. Work waits and tries again, so it is logged
 * as a warning; the operator's own account refusing requests is still reported.
 */
export function isSandboxProviderOutage(error: unknown): error is Error {
  return (
    (error instanceof SandboxUnresponsiveError &&
      !(error instanceof SandboxProviderAccountError)) ||
    error instanceof SandboxUnavailableError ||
    error instanceof SandboxRateLimitError
  );
}

/** A computer's workspace is over the size or file count a save allows, so it is not saved. */
export class WorkspaceTooLargeError extends Error {
  readonly code = "WORKSPACE_TOO_LARGE";
  constructor(readonly limit: "bytes" | "files") {
    super(
      limit === "bytes"
        ? "The computer's files are too large to save"
        : "The computer has too many files to save",
    );
    this.name = "WorkspaceTooLargeError";
  }
}

/**
 * The computer is up but its system can no longer start programs, so nothing on it can run or
 * be saved. Waiting does not fix it; Recover rebuilds the computer from its last save.
 */
export class SandboxDamagedError extends Error {
  readonly code = "SANDBOX_DAMAGED";
  constructor(options?: { cause?: unknown }) {
    super("This computer's system is damaged. Recover the computer to rebuild it.", options);
    this.name = "SandboxDamagedError";
  }
}

/**
 * The provider would not start the computer at the size asked for: the operator's account does
 * not offer it, or the computer's files would not fit a smaller one. The computer is unchanged.
 */
export class SandboxSizeUnavailableError extends Error {
  readonly code = "SANDBOX_SIZE_UNAVAILABLE";
  constructor(
    readonly reason: "not_offered" | "too_small",
    options?: { cause?: unknown },
  ) {
    super(
      reason === "too_small"
        ? "The computer's files do not fit a smaller size"
        : "This computer size is not available",
      options,
    );
    this.name = "SandboxSizeUnavailableError";
  }
}
