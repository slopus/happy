import { sanitizeJsonValue, sanitizeUtf16ForJson } from "@rakazo/core";
import type { PrismaClient } from "./generated/prisma/client.js";

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const WRITE_KEYS = ["data", "create", "update"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy-on-change: untouched values keep their identity. Dates, bytes, and decimals pass through. */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeUtf16ForJson(value);
  if (Array.isArray(value)) {
    const items = value.map(sanitizeValue);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  // Only JSON can carry such a key (Prisma field names cannot); keep colliding keys apart.
  if (keys.some((key) => sanitizeUtf16ForJson(key) !== key)) return sanitizeJsonValue(value);
  return sanitizeEntries(value, keys);
}

function sanitizeEntries(value: Record<string, unknown>, keys: readonly string[]) {
  let out: Record<string, unknown> | undefined;
  for (const key of keys) {
    if (!(key in value)) continue;
    const next = sanitizeValue(value[key]);
    if (next === value[key]) continue;
    out ??= { ...value };
    out[key] = next;
  }
  return out ?? value;
}

/**
 * Postgres rejects NUL in text columns, and NUL or an unpaired surrogate in json, so one such
 * character in pasted or tool-produced text would fail the whole write. Replace them in every
 * written value. Filters are left alone: they read rows and cannot store anything.
 */
export function sanitizeWriteArgs(operation: string, args: unknown): unknown {
  if (!WRITE_OPERATIONS.has(operation) || !isPlainObject(args)) return args;
  return sanitizeEntries(args, WRITE_KEYS);
}

export function withTextSanitization(prisma: PrismaClient): PrismaClient {
  return prisma.$extends({
    query: {
      $allModels: {
        $allOperations({ operation, args, query }) {
          return query(sanitizeWriteArgs(operation, args) as typeof args);
        },
      },
    },
  }) as unknown as PrismaClient;
}
