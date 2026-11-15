import { ORPCError, ValidationError } from "@orpc/server";
import {
  SandboxAllowanceUsedError,
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  VoiceAccountError,
} from "@rakazo/adapter-kit";
import { ComputerRecoveryRequiredError } from "@rakazo/adapters";
import {
  databaseOutage,
  IsolationError,
  ProviderTransactionBusyError,
  SpaceDeletionInProgressError,
  SpaceOwnerRequiredError,
} from "@rakazo/db";
import { enrichLogContext, getLogContext, getLogger } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { voiceAccountErrorStatus } from "./voice.js";

/** How long a client waits before asking again while the database fails over. */
export const DATABASE_RETRY_AFTER_SECONDS = 5;
const DATABASE_UNAVAILABLE = "db.unavailable";

/**
 * Whether a request failed because the database is unavailable. The outage logs it once for
 * every request it fails, and the request's 503 is expected rather than a report.
 */
export function failedOnDatabaseOutage(error: unknown): boolean {
  if (!databaseOutage.failed(error, "api request")) return false;
  markExpectedFailure();
  enrichLogContext({ [DATABASE_UNAVAILABLE]: true });
  return true;
}

/** Whether this request failed on a database outage, so its 503 asks the client to retry soon. */
export function requestHitDatabaseOutage(): boolean {
  return getLogContext()[DATABASE_UNAVAILABLE] === true;
}

/**
 * Hono's default prints the stack and answers 500. Requests already log their failure, and a
 * database outage answers 503 so clients try again.
 */
export function handleHttpError(error: Error, c: Context): Response {
  if (error instanceof HTTPException) return error.getResponse();
  if (failedOnDatabaseOutage(error))
    return c.text("Service Unavailable", 503, {
      "Retry-After": String(DATABASE_RETRY_AFTER_SECONDS),
    });
  return c.text("Internal Server Error", 500);
}

/**
 * Non-ORPCError failures are flattened into an opaque "Internal server error", so this log is
 * the only record of what broke. The cause chain matters: undici and most SDKs report a bare
 * "fetch failed" and keep the host and errno one level down.
 */
export function handleRpcError(
  error: unknown,
  path: readonly string[],
  signal?: AbortSignal,
): void {
  // A missing or foreign resource is the caller's mistake (a stale client, a deleted bot),
  // not a server failure, so it is a warning rather than an error report.
  if (error instanceof IsolationError) {
    getLogger().warn(`rpc ${path.join("/")} not found`, { "error.stack": error.stack });
    throw new ORPCError("NOT_FOUND", { message: error.message, cause: error });
  }
  if (failedOnDatabaseOutage(error)) {
    throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
  }
  if (error instanceof SpaceOwnerRequiredError) {
    throw new ORPCError("FORBIDDEN", { message: error.message, cause: error });
  }
  // A Space being deleted takes no new work; the caller learns it, nothing failed.
  if (error instanceof SpaceDeletionInProgressError) {
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // The user's own voice account refused the request: theirs to fix.
  if (error instanceof VoiceAccountError) {
    getLogger().warn(`rpc ${path.join("/")} voice provider account rejected the request`, {
      reason: error.code ?? error.message,
    });
    throw new ORPCError(error.code ?? "FORBIDDEN", {
      status: voiceAccountErrorStatus(error.code),
      message: error.message,
      cause: error,
    });
  }
  // The computer provider did not start the computer in time, or could not be reached: an outage
  // on its side the user can retry, not a server failure.
  if (error instanceof SandboxUnavailableError || error instanceof SandboxUnresponsiveError) {
    const unavailable =
      error instanceof SandboxUnavailableError
        ? error
        : new SandboxUnavailableError({ cause: error });
    getLogger().warn(`rpc ${path.join("/")} computer unavailable`, {
      reason: unavailable.cause instanceof Error ? unavailable.cause.message : undefined,
    });
    markExpectedFailure();
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: unavailable.message, cause: error });
  }
  // A provider kept another transaction busy past the wait; nothing failed, so the caller retries.
  if (error instanceof ProviderTransactionBusyError) {
    getLogger().warn(`rpc ${path.join("/")} provider transaction busy`);
    markExpectedFailure();
    throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message, cause: error });
  }
  if (error instanceof SandboxRateLimitError) {
    getLogger().warn(`rpc ${path.join("/")} computer rate limited`, {
      reason: error.cause instanceof Error ? error.cause.message : undefined,
    });
    throw new ORPCError("TOO_MANY_REQUESTS", { message: error.message, cause: error });
  }
  // The organization spent this period's computer allowance; its message says so.
  if (error instanceof SandboxAllowanceUsedError) {
    getLogger().warn(`rpc ${path.join("/")} computer allowance used up`);
    throw new ORPCError("FORBIDDEN", { message: error.message, cause: error });
  }
  // An unconfirmed stop leaves the computer isolated until the owner recovers it.
  if (error instanceof ComputerRecoveryRequiredError) {
    getLogger().warn(`rpc ${path.join("/")} computer requires recovery`);
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // A retry cannot fix a damaged computer; its message tells the user to Recover it.
  if (error instanceof SandboxDamagedError) {
    getLogger().warn(`rpc ${path.join("/")} computer damaged`);
    throw new ORPCError("CONFLICT", { message: error.message, cause: error });
  }
  // The client went away mid-request, so whatever failed next has no one waiting for it.
  if (signal?.aborted && !(error instanceof ORPCError)) {
    getLogger().warn(`rpc ${path.join("/")} client disconnected`, {
      reason: error instanceof Error ? error.message : String(error),
    });
    markExpectedFailure();
    return;
  }
  logUnexpectedRpcError(error, path);
}

export function logUnexpectedRpcError(error: unknown, path: readonly string[]): void {
  // A procedure's own 5xx (a store it depends on is down) would otherwise reach the collector
  // only as an anonymous failed request; report it under the procedure with its cause.
  if (error instanceof ORPCError && error.status < 500) return;
  // The procedure already logged this outage as a warning and marked its 5xx expected.
  if (getLogContext()["error.expected"]) return;
  const where = `rpc ${path.join("/")} failed`;
  const cause = error instanceof ORPCError ? error.cause : undefined;
  if (cause instanceof ValidationError) {
    // Paths and schema messages only: the rejected data can hold message content.
    const issues = cause.issues.slice(0, 10).map((issue) => {
      const keys = (issue.path ?? []).map((key) => String(typeof key === "object" ? key.key : key));
      return `${keys.join(".")}: ${issue.message}`;
    });
    getLogger().error(where, error, { "validation.issues": issues.join("; ") });
    return;
  }
  getLogger().error(where, error);
}
