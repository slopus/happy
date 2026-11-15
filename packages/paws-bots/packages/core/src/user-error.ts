import { MCP_OAUTH_REDIRECT_MISMATCH } from "@rakazo/contracts";

/** Only reviewed, public documentation links belong here; never use URLs from an error body. */
const ERROR_GUIDES: Readonly<Record<string, string>> = {
  [MCP_OAUTH_REDIRECT_MISMATCH]:
    "https://rakazo.com/docs/troubleshooting/#mcp-oauth-redirect-mismatch",
};

/** A stable error code opts into troubleshooting without depending on message wording. */
export function errorHelpUrl(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && Object.hasOwn(ERROR_GUIDES, code)
    ? ERROR_GUIDES[code]
    : undefined;
}

/** Copy each client supplies in its own language. */
export type UserErrorCopy = { fallback: string; offline: string };

/** Browser, React Native, Expo, and Node wordings for a request that never got a response. */
const NETWORK_FAILURE =
  /^(?:failed to fetch|load failed|fetch failed|network ?error|network request failed)|networkerror when attempting|could not connect to the server|internet connection appears to be offline/i;
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
]);

/** Implementation detail that should never reach the screen as-is. */
const TECHNICAL_MESSAGE = [
  /\[(?:body|query|params|headers)(?:\.[^\]]*)?\]/, // validation issue paths
  /\w+Exception\b/,
  /^\w*Error:/,
  /\(at \S+:\d+|\bat \S+ \(\S+:\d+(?::\d+)?\)|\.(?:swift|kt|java|mm?|[cm]?[jt]sx?):\d+/, // stack frames
  /^\s*[[{]/, // JSON
  /^rpc \S+ failed|\(\d{3}\)|\bstatus(?: code)? \d{3}\b/i, // HTTP status dumps
  /\bE(?:CONN[A-Z]+|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // bare internal codes
  /\d+ bytes\b/,
  /unexpected token|is not a function|cannot read propert|undefined is not|null is not an object|json parse error/i,
  /^input validation failed\b/i, // oRPC's generic schema-rejection banner names no field
];

/** True when a thrown value means the server could not be reached at all. */
export function isNetworkFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (NETWORK_FAILURE.test(current.message.trim())) return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

/** True when the client itself gave up on a request: a timeout or a cancellation. */
export function isAbandonedRequest(error: unknown): boolean {
  let current = error;
  for (let depth = 0; typeof current === "object" && current !== null && depth < 4; depth += 1) {
    const { name } = current as { name?: unknown };
    if (name === "TimeoutError" || name === "AbortError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when a request never got a response because of the connection (offline, DNS, a dropped
 * connection) or because the client timed out or cancelled it: the user's network, not a bug.
 */
export function isConnectionFailure(error: unknown): boolean {
  return isNetworkFailure(error) || isAbandonedRequest(error);
}

/** True for the gateway answers a proxy gives while the server is down or restarting. */
export function isUnreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/**
 * True when a request may never have reached the server (no connection, a timeout, or a gateway
 * error), so sending it again later is safe and right; false when the server answered.
 */
export function isServerUnreachable(error: unknown): boolean {
  if (isNetworkFailure(error)) return true;
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (current.name === "TimeoutError") return true;
    const status = (current as { status?: unknown }).status;
    if (typeof status === "number" && isUnreachableStatus(status)) return true;
    current = current.cause;
  }
  return false;
}

export function isTechnicalErrorMessage(message: string): boolean {
  return TECHNICAL_MESSAGE.some((pattern) => pattern.test(message));
}

/**
 * The text to show for a failure: messages written for people (server copy, client copy) pass
 * through; transport failures and implementation detail become the caller's copy.
 */
export function userErrorMessage(error: unknown, copy: UserErrorCopy): string {
  if (isServerUnreachable(error)) return copy.offline;
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).trim();
  return message && !isTechnicalErrorMessage(message) ? message : copy.fallback;
}

export type CredentialField = "email" | "password";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Catches empty or malformed credentials before they round-trip to the server. */
export function credentialIssue(input: {
  email: string;
  password?: string;
}): CredentialField | null {
  if (!EMAIL.test(input.email.trim())) return "email";
  if (input.password !== undefined && !input.password) return "password";
  return null;
}

export type AuthErrorCopy = Record<CredentialField, string> & { fallback: string };

/**
 * Copy for a failed auth response body (`{ code, message }`). Request validation failures name
 * the rejected inputs as issue paths (`[body.email] …`), so map those to field copy.
 */
export function authErrorMessage(body: unknown, copy: AuthErrorCopy): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message : "";
  if (record.code === "VALIDATION_ERROR") {
    const fields = new Set([...message.matchAll(/\[body\.(\w+)/g)].map((match) => match[1]));
    if (fields.has("email")) return copy.email;
    if (fields.has("password")) return copy.password;
    return copy.fallback;
  }
  return message && !isTechnicalErrorMessage(message) ? message : copy.fallback;
}
