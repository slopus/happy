import { createHash } from "node:crypto";

/** JSON Schema for a tool's arguments, as an MCP server advertises it. */
export type ToolSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: false;
};

export type AppTool = {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  /** Advertised as the MCP `readOnlyHint`; a tool that is not read-only is recorded as a write. */
  readOnly: boolean;
  run: (args: Record<string, unknown>) => unknown;
};

export type AppErrorCode = "invalid_argument" | "not_found" | "permission_denied" | "rate_limited";

const STATUS: Record<AppErrorCode, number> = {
  invalid_argument: 400,
  permission_denied: 403,
  not_found: 404,
  rate_limited: 429,
};

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** A rate limit a fixture switches on: the first `times` calls to `tool` fail with a retry time. */
export type AppFault = { tool: string; times: number; retryAfterSeconds: number };

export type AppCall = {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  write: boolean;
  error: { code: AppErrorCode; message: string } | null;
};

/** A successful write: what it targeted and, for an update, the record before and after. */
export type AppWrite = {
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  target: string;
  before?: unknown;
  after: unknown;
};

export type AppResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { code: AppErrorCode; status: number; message: string; retry_after_seconds?: number };
    };

export type AppEmulatorOptions = {
  /** The service's present moment. Seeds are written relative to it, so runs stay deterministic. */
  now: Date;
  faults?: AppFault[];
};

/**
 * A stateful, offline stand-in for a connected service. Every call is logged and every
 * successful write recorded, so graders read effects instead of the bot's claims.
 */
export abstract class AppEmulator {
  abstract readonly kind: string;
  abstract readonly displayName: string;
  readonly calls: AppCall[] = [];
  readonly writes: AppWrite[] = [];
  /** The service clock the seed was written against. */
  readonly now: Date;
  private readonly faults: Array<AppFault & { fired: number }>;
  private ids = 0;

  constructor(options: AppEmulatorOptions) {
    this.now = options.now;
    this.faults = (options.faults ?? []).map((fault) => ({ ...fault, fired: 0 }));
  }

  abstract tools(): AppTool[];

  call(name: string, args: Record<string, unknown> = {}): AppResult {
    const tool = this.tools().find((candidate) => candidate.name === name);
    const entry: AppCall = {
      seq: this.calls.length + 1,
      tool: name,
      args: structuredClone(args),
      write: tool ? !tool.readOnly : false,
      error: null,
    };
    this.calls.push(entry);
    try {
      if (!tool) throw new AppError("not_found", `Unknown tool ${name}`);
      this.injectFault(name);
      validateArgs(tool.inputSchema, args);
      return { ok: true, data: tool.run(args) };
    } catch (error) {
      const failure =
        error instanceof AppError
          ? error
          : new AppError("invalid_argument", error instanceof Error ? error.message : "Failed");
      entry.error = { code: failure.code, message: failure.message };
      return {
        ok: false,
        error: {
          code: failure.code,
          status: STATUS[failure.code],
          message: failure.message,
          ...(failure.retryAfterSeconds === undefined
            ? {}
            : { retry_after_seconds: failure.retryAfterSeconds }),
        },
      };
    }
  }

  /** Writes made through one tool, in order. */
  writesTo(tool: string) {
    return this.writes.filter((write) => write.tool === tool);
  }

  protected record(write: Omit<AppWrite, "seq">) {
    this.writes.push(structuredClone({ seq: this.calls.length, ...write }));
  }

  /** The time of the current write: the service clock, a second per call so writes stay ordered. */
  protected stamp() {
    return new Date(this.now.getTime() + this.calls.length * 1000).toISOString();
  }

  /** A stable id for something created during the run. */
  protected nextId(prefix: string, length = 16) {
    this.ids += 1;
    return `${prefix}${stableId(`${this.kind}:${this.ids}`, length)}`;
  }

  private injectFault(tool: string) {
    for (const fault of this.faults) {
      if (fault.tool !== tool || fault.fired >= fault.times) continue;
      fault.fired += 1;
      throw new AppError(
        "rate_limited",
        `Rate limit exceeded. Retry after ${fault.retryAfterSeconds} seconds.`,
        fault.retryAfterSeconds,
      );
    }
  }
}

/** A deterministic opaque id: lowercase hex from a seed. */
export function stableId(seed: string, length = 16) {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

/** Offset pagination behind an opaque token bound to the request it came from. */
export function paginate<T>(
  items: T[],
  options: { size: unknown; token: unknown; scope: string; fallback: number; max: number },
): { page: T[]; next: string | null } {
  const size = clampSize(options.size, options.fallback, options.max);
  let offset = 0;
  if (options.token !== undefined && options.token !== null && options.token !== "") {
    const decoded = decodeToken(String(options.token));
    if (!decoded || decoded.scope !== stableId(options.scope, 8))
      throw new AppError(
        "invalid_argument",
        "Invalid page token. Repeat the request without a token to start over.",
      );
    offset = decoded.offset;
  }
  const page = items.slice(offset, offset + size);
  const nextOffset = offset + size;
  return {
    page,
    next:
      nextOffset < items.length
        ? Buffer.from(`${stableId(options.scope, 8)}:${nextOffset}`).toString("base64url")
        : null,
  };
}

function decodeToken(token: string) {
  const [scope, offset] = Buffer.from(token, "base64url").toString("utf8").split(":");
  const value = Number(offset);
  return scope && Number.isInteger(value) && value >= 0 ? { scope, offset: value } : null;
}

function clampSize(value: unknown, fallback: number, max: number) {
  if (value === undefined || value === null) return fallback;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1)
    throw new AppError("invalid_argument", "Page size must be a positive integer.");
  return Math.min(size, max);
}

/** The checks a typical server's schema validation makes before running a tool. */
function validateArgs(schema: ToolSchema, args: Record<string, unknown>) {
  for (const key of schema.required ?? [])
    if (args[key] === undefined || args[key] === null || args[key] === "")
      throw new AppError("invalid_argument", `Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) {
      if (schema.additionalProperties === false)
        throw new AppError(
          "invalid_argument",
          `Unknown argument: ${key}. Valid arguments: ${Object.keys(schema.properties).join(", ")}`,
        );
      continue;
    }
    if (value === undefined || value === null) continue;
    const type = property.type;
    const actual = Array.isArray(value) ? "array" : typeof value;
    const matches =
      type === undefined ||
      (Array.isArray(type) ? type.includes(actual) : type === actual) ||
      (type === "integer" && Number.isInteger(value));
    if (!matches)
      throw new AppError(
        "invalid_argument",
        `Argument ${key} must be ${Array.isArray(type) ? type.join(" or ") : String(type)}.`,
      );
    const options = property.enum as unknown[] | undefined;
    if (options && !options.includes(value))
      throw new AppError(
        "invalid_argument",
        `Argument ${key} must be one of: ${options.map(String).join(", ")}.`,
      );
  }
}

const DAY = 86_400_000;

/** A time relative to the service clock: `daysAgo` days back at a UTC wall time. */
export function relativeTime(now: Date, daysAgo: number, time = "09:00") {
  const [hours, minutes] = time.split(":").map(Number);
  const day = new Date(now.getTime() - daysAgo * DAY);
  day.setUTCHours(hours ?? 9, minutes ?? 0, 0, 0);
  return day.toISOString();
}

/** A calendar date relative to the service clock, YYYY-MM-DD. */
export function relativeDate(now: Date, daysFromNow: number) {
  return new Date(now.getTime() + daysFromNow * DAY).toISOString().slice(0, 10);
}

/**
 * Split free text into lowercase words and quoted phrases, keeping `-` negations and `key:`
 * operators. A pasted link stays a plain word, not an `https:` operator. `or` marks a term joined
 * to the one before it by an uppercase OR, which binds only those neighbours.
 */
export function queryTerms(query: string) {
  const terms: Array<{ text: string; negate: boolean; key?: string; or?: true }> = [];
  const pattern = /(-)?(?:([a-z_]+):(?!\/\/))?(?:"([^"]*)"|(\S+))/gi;
  let or = false;
  for (const match of query.matchAll(pattern)) {
    if (match[0] === "OR") {
      or = terms.length > 0;
      continue;
    }
    const text = (match[3] ?? match[4] ?? "").toLowerCase();
    if (!text) continue;
    terms.push({
      text,
      negate: Boolean(match[1]),
      ...(match[2] ? { key: match[2].toLowerCase() } : {}),
      ...(or ? { or: true as const } : {}),
    });
    or = false;
  }
  return terms;
}
