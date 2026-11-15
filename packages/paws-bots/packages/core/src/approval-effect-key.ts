import { createHash } from "node:crypto";

function invalidJsonValue(): never {
  throw new TypeError("Approval arguments must contain only JSON values");
}

export function stableJsonValue(value: unknown): string {
  const ancestors = new WeakSet<object>();

  function serialize(current: unknown): string {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? JSON.stringify(current) : invalidJsonValue();
    }
    if (typeof current !== "object") return invalidJsonValue();
    if (ancestors.has(current)) return invalidJsonValue();

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const items: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!(index in current)) return invalidJsonValue();
          items.push(serialize(current[index]));
        }
        return `[${items.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return invalidJsonValue();
      const object = current as Record<string, unknown>;
      const entries = Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return serialize(value);
}

export function approvalEffectKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256").update(stableJsonValue(args)).digest("hex");
  return `${runId}:${toolName}:${digest}`;
}

/**
 * Stable mutating-tool key for a run, tool, args, and live occurrence.
 * Model tool-call ids change on replay, so they must not be part of the key.
 * Occurrence 0 keeps the unsuffixed form so existing rows still match.
 * Later identical-args calls in the same live attempt use 1, 2, …
 */
export function toolEffectIdempotencyKey(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
  occurrence = 0,
): string {
  const base = approvalEffectKey(runId, toolName, args);
  return occurrence > 0 ? `${base}:${occurrence}` : base;
}

/** True when `key` is a current-style run/tool/args key (any occurrence). */
export function isToolEffectIdempotencyKey(key: string, runId: string, toolName: string): boolean {
  const prefix = `${runId}:${toolName}:`;
  if (!key.startsWith(prefix)) return false;
  return /^[a-f0-9]{64}(?::\d+)?$/.test(key.slice(prefix.length));
}

/** Pre-fix rows that included the ephemeral provider tool-call id. */
export function legacyScopedToolEffectIdempotencyKey(
  runId: string,
  toolName: string,
  executionId: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256").update(stableJsonValue(args)).digest("hex");
  return `${runId}:${toolName}:${executionId}:${digest}`;
}
