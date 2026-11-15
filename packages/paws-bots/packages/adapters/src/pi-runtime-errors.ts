import {
  isTransientModelError,
  ModelAccountError,
  ModelOutputError,
  TransientModelError,
} from "@rakazo/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import {
  MODEL_OUTPUT_LIMIT_ERROR,
  normalizeRunError,
  parseModelFallbackFailure,
} from "@rakazo/core";
import { LOCAL_PROVIDER_ID } from "./pi-local-provider-id.js";
import { terminalOAuthRefreshErrorMarker } from "./pi-oauth.js";
import { isOpenCodeProvider } from "./pi-runtime-stream.js";

export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
        ? String(part.text)
        : "",
    )
    .join("");
}

export function messageHasToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("content" in message)) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => !!part && typeof part === "object" && "type" in part && part.type === "toolCall",
  );
}

/** Provider failure. Aborts stay on the existing cancel path. */
export function providerFailureText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (!("role" in message) || message.role !== "assistant") return undefined;
  const stopReason =
    "stopReason" in message && typeof message.stopReason === "string"
      ? message.stopReason
      : undefined;
  if (stopReason === "aborted") return undefined;
  const errorMessage =
    "errorMessage" in message &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim()
      ? message.errorMessage.trim()
      : undefined;
  const text = assistantText(message).trim();
  if (stopReason === "error") {
    if (errorMessage) return errorMessage;
    if (text) return "The model failed after writing a response.";
    return "The model failed before writing a response.";
  }
  if (stopReason === "length" && !text) {
    return errorMessage || MODEL_OUTPUT_LIMIT_ERROR;
  }
  if (errorMessage && !text) return errorMessage;
  return undefined;
}

export function sanitizeSensitiveText(message: string) {
  return message
    .replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[^\s"',;&]+/gi, "Bearer [redacted]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[redacted]")
    .replace(/COMPOSIO_API_KEY[=:]?\s*\S+/gi, "COMPOSIO_API_KEY=[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s"',;&]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:auth|authorization)\s*[=:]\s*)(?!Bearer\b)[^\s"',;&]+/gi, "$1[redacted]");
}

export function sanitizeError(message: string) {
  return sanitizeSensitiveText(message);
}

const OPENCODE_SESSION_ERROR = "OpenCode rejected this chat session. Send the message again.";

function looksLikeOpenCodeSessionError(message: string): boolean {
  return (
    /x-opencode-session/i.test(message) ||
    /session\s*(id|header|required|missing|invalid|expired|stale)/i.test(message) ||
    /model is unavailable/i.test(message)
  );
}

/**
 * Endpoints the user or operator runs and configures; a deployment-funded model never uses them.
 */
const OWN_ENDPOINT_PROVIDERS = new Set([OPENAI_COMPATIBLE_PROVIDER_ID, LOCAL_PROVIDER_ID]);

/**
 * One classification for retries, reporting and the run error view. A failure the view
 * attributes to the user's provider account, key, plan or model choice, or to the model's own
 * unusable output, is not a server fault. Anything it cannot place stays a plain error.
 * `provider` served `error`; `primaryProvider` served the first model of a fallback chain.
 */
export function modelFailure(
  error: string,
  message: string,
  { provider, primaryProvider }: { provider: string; primaryProvider: string },
): Error {
  // When every model failed, the run is only as clear as its least explained failure: an
  // unexplained part stays a server error, and a part the user must fix outranks bad output,
  // which outranks one that clears on its own. Skipped backups never ran, so they do not count.
  const fallback = parseModelFallbackFailure(message);
  const failures = fallback
    ? [
        modelFailureClass(fallback.primaryError, fallback.primaryError, primaryProvider),
        ...fallback.backups
          .filter((item) => item.status === "failed")
          .map((item) => modelFailureClass(item.reason, item.reason, item.provider)),
      ]
    : [modelFailureClass(error, message, provider)];
  const Failure = MODEL_FAILURE_RANK[Math.max(...failures)] ?? Error;
  return new Failure(message);
}

/** Least to most severe; a server fault (plain Error) is last. */
const MODEL_FAILURE_RANK = [TransientModelError, ModelOutputError, ModelAccountError, Error];

function modelFailureClass(error: string, message: string, provider: string): number {
  const { kind, recovery, status } = normalizeRunError(message);
  // Output diagnostics can quote generated text that looks like a timeout.
  if (kind === "output") return MODEL_FAILURE_RANK.indexOf(ModelOutputError);
  // OpenCode drops chat sessions on its side; the next send opens a new one.
  if (isTransientModelError(error) || message === OPENCODE_SESSION_ERROR)
    return MODEL_FAILURE_RANK.indexOf(TransientModelError);
  // A refresh token the provider no longer accepts; the credential is already retired.
  if (terminalOAuthRefreshErrorMarker(message))
    return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  if (kind || recovery) return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  // The user's own endpoint refused a request its model or settings cannot take. On a named
  // provider the same rejection more likely means Rakazo built the request wrong.
  if ((status === 400 || status === 422) && OWN_ENDPOINT_PROVIDERS.has(provider))
    return MODEL_FAILURE_RANK.indexOf(ModelAccountError);
  return MODEL_FAILURE_RANK.indexOf(Error);
}

export function sanitizeProviderError(provider: string, message: string): string {
  const sanitized = sanitizeError(message);
  if (isOpenCodeProvider(provider) && looksLikeOpenCodeSessionError(sanitized)) {
    return OPENCODE_SESSION_ERROR;
  }
  return sanitized;
}
