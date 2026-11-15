import { redactBindings, redactSensitiveText } from "./redaction.js";
import type { SerializedError } from "./types.js";

const MAX_CAUSE_DEPTH = 5;

export function serializeError(error: unknown, seen = new Set<unknown>()): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: stringifyUnknown(error) };
  }
  if (seen.has(error)) {
    return { name: error.name, message: "[Circular]" };
  }
  seen.add(error);
  const serialized: SerializedError = {
    name: error.name || "Error",
    message: redactSensitiveText(error.message),
  };
  // Database drivers and Node put a stable machine code (P2002, ECONNRESET) beside the message.
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) serialized.code = code;
  // Prisma's meta names the database's own code, or the timeout a transaction ran past.
  const meta = (error as { meta?: unknown }).meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    serialized.meta = redactBindings(meta as Record<string, unknown>);
  }
  if (typeof error.stack === "string" && error.stack.length > 0) {
    serialized.stack = redactSensitiveText(error.stack);
  }
  // An AggregateError holds the failure it reports in `errors`; the first is why it was thrown.
  const cause =
    error.cause ?? (error instanceof AggregateError ? (error.errors as unknown[])[0] : undefined);
  if (cause !== undefined && seen.size < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, seen);
  }
  return serialized;
}

const PRISMA_INVOCATION = /^Invalid `(?:\w+\.)*(\w+\.\w+)\(\)` invocation/;

/**
 * Collectors title an issue by the first line of the message. Prisma's errors start with a
 * blank line and name the failing call only in their body, so lead with the error code and
 * the model operation instead.
 */
export function errorSummary(message: string, code: string | undefined): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const call = lines[0]?.match(PRISMA_INVOCATION)?.[1];
  const summary = call ? `${call}: ${lines.slice(1).join(" ")}` : message.trimStart();
  return code && !summary.includes(code) ? `${code} ${summary}` : summary;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return redactSensitiveText(JSON.stringify(value) ?? String(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}
