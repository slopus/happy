import { redactSensitiveText } from "./redaction.js";

/** Shared by log sinks and client adapters; these names are also the collector tags. */
export const CORRELATION_TAG_KEYS = [
  "request.id",
  "trace.id",
  "job.id",
  "run.id",
  "space.id",
  "thread.id",
  "bot.id",
  "computer.id",
  "routine.id",
  "skill.id",
  "connector.id",
] as const;

export interface MonitoringConfig {
  dsn: string | null;
  environment?: string | null;
  release?: string | null;
  tunnel?: string;
  userId?: string | null;
}

export function isMonitoringUserId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function scrubMonitoringText(value: string): string {
  return redactSensitiveText(value);
}

export function stripMonitoringUrl(value: string): string {
  return scrubMonitoringText(value.split(/[?#]/, 1)[0]!);
}

/** Preserve the original stack and cause without mutating the error used by product recovery. */
export function sanitizedError(
  value: unknown,
  scrub: (text: string) => string = scrubMonitoringText,
  seen = new Set<unknown>(),
): Error {
  if (!(value instanceof Error))
    return new Error(scrub(typeof value === "string" ? value : "Unknown failure"));
  if (seen.has(value) || seen.size >= 5) return new Error("[Truncated cause]");
  seen.add(value);
  const result = new Error(scrub(value.message));
  result.name = scrub(value.name);
  if (value.stack) result.stack = scrub(value.stack);
  // A driver's code and Prisma's meta tell a timeout from a conflict; keep them, scrubbed.
  const { code, meta } = value as { code?: unknown; meta?: unknown };
  if (typeof code === "string") Object.assign(result, { code: scrub(code) });
  if (meta && typeof meta === "object") Object.assign(result, { meta: scrubbed(meta, scrub) });
  if (value.cause !== undefined) result.cause = sanitizedError(value.cause, scrub, seen);
  return result;
}

function scrubbed(value: unknown, scrub: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= 5) return "[Truncated]";
  if (Array.isArray(value)) return value.map((item) => scrubbed(item, scrub, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubbed(item, scrub, depth + 1)]),
  );
}

export interface MonitoringBreadcrumb {
  type?: string;
  category: string;
  level?: "fatal" | "error" | "warning" | "info" | "debug" | "log";
  data?: Record<string, string | number | boolean>;
  timestamp?: number;
}

const SYSTEM_BREADCRUMBS = new Set([
  "navigation",
  "app.lifecycle",
  "ui.lifecycle",
  "device.event",
  "device.orientation",
  "network.event",
  "system",
]);
const HTTP_BREADCRUMBS = new Set(["http", "xhr", "fetch"]);
// Native view controller breadcrumbs also carry titles, which can be a chat name.
const SYSTEM_DATA_KEYS = [
  "screen",
  "state",
  "action",
  "from",
  "to",
  "level",
  "charging",
  "plugged",
  "position",
  "orientation",
  "type",
] as const;
const BREADCRUMB_LEVELS = new Set(["fatal", "error", "warning", "info", "debug", "log"]);
const IDENTIFIER = /^[\w.:-]{1,100}$/;

/** Only API paths survive, with any segment that could be an id or token replaced. */
function breadcrumbUrl(value: string): string {
  let path: string;
  try {
    path = new URL(value, "http://relative.invalid").pathname;
  } catch {
    return "[external]";
  }
  const segments = path.split("/");
  if (segments[1] !== "api" && segments[1] !== "rpc") return "[external]";
  return segments
    .map((segment) =>
      segment === "" || /^(?:[a-zA-Z][a-zA-Z_.-]{0,63}|v\d{1,2})$/.test(segment) ? segment : ":id",
    )
    .join("/")
    .slice(0, 200);
}

/** An allowlist: no message, console output, bodies, headers, titles or touch targets. */
export function sanitizeMonitoringBreadcrumb(value: unknown): MonitoringBreadcrumb | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const { category } = source;
  if (typeof category !== "string") return null;
  const http = HTTP_BREADCRUMBS.has(category);
  if (!http && !SYSTEM_BREADCRUMBS.has(category)) return null;
  const crumb: MonitoringBreadcrumb = { category };
  if (typeof source.type === "string" && /^[a-z]{1,20}$/.test(source.type))
    crumb.type = source.type;
  if (typeof source.level === "string" && BREADCRUMB_LEVELS.has(source.level))
    crumb.level = source.level as MonitoringBreadcrumb["level"];
  // Native SDKs send ISO strings; the event protocol accepts either as seconds.
  const timestamp =
    typeof source.timestamp === "string" ? Date.parse(source.timestamp) / 1000 : source.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) crumb.timestamp = timestamp;
  const input =
    source.data && typeof source.data === "object" ? (source.data as Record<string, unknown>) : {};
  const data: Record<string, string | number | boolean> = {};
  if (http) {
    if (typeof input.method === "string" && /^[A-Z]{1,10}$/.test(input.method))
      data.method = input.method;
    if (Number.isInteger(input.status_code)) data.status_code = input.status_code as number;
    if (typeof input.url === "string") data.url = breadcrumbUrl(input.url);
  } else {
    for (const key of SYSTEM_DATA_KEYS) {
      const item = input[key];
      if (
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)) ||
        (typeof item === "string" && IDENTIFIER.test(item))
      )
        data[key] = item;
    }
  }
  if (Object.keys(data).length) crumb.data = data;
  return crumb;
}

function sanitizedBreadcrumbs(value: unknown): MonitoringBreadcrumb[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { values?: unknown }).values)
      ? (value as { values: unknown[] }).values
      : [];
  return list
    .slice(-100)
    .map(sanitizeMonitoringBreadcrumb)
    .filter((crumb) => crumb !== null);
}

interface MonitoringEvent {
  message?: string;
  request?: { url?: string; headers?: unknown; cookies?: unknown; data?: unknown };
  user?: { id?: string | number; ip_address?: string | null };
  extra?: Record<string, unknown>;
  breadcrumbs?: unknown;
  server_name?: string;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: { frames?: Array<{ filename?: string; abs_path?: string; vars?: unknown }> };
    }>;
  };
}

/** No native paths, account details, request content or arbitrary SDK extras. */
export function sanitizeMonitoringEvent<T extends MonitoringEvent>(event: T, userId?: string): T {
  if (event.request) {
    if (event.request.url) event.request.url = stripMonitoringUrl(event.request.url);
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.data;
  }
  event.user = isMonitoringUserId(userId) ? { id: userId, ip_address: null } : { ip_address: null };
  delete event.extra;
  if (event.breadcrumbs !== undefined) {
    const breadcrumbs = sanitizedBreadcrumbs(event.breadcrumbs);
    if (breadcrumbs.length) (event as MonitoringEvent).breadcrumbs = breadcrumbs;
    else delete event.breadcrumbs;
  }
  delete event.server_name;
  if (event.message) event.message = scrubMonitoringText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = scrubMonitoringText(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = stripMonitoringUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = stripMonitoringUrl(frame.abs_path);
      delete frame.vars;
    }
  }
  return event;
}

export type ClientOperation =
  | "react.render"
  | "mobile.startup"
  | "voice.microphone"
  | "voice.turn"
  | "rpc.transport"
  | "desktop.startup"
  | "desktop.update"
  | "desktop.renderer"
  | "desktop.child"
  | "desktop.menu"
  | "desktop.unresponsive";

export interface ClientErrorReporter {
  capture(error: unknown, operation: ClientOperation, tags?: Record<string, string>): void;
}

/** Bounded queue while an optional SDK/config loads. Switching servers clears pending reports. */
export function createClientErrorReporter() {
  let reporter: ClientErrorReporter | undefined;
  let pending: Array<Parameters<ClientErrorReporter["capture"]>> = [];
  let enabled = true;
  return {
    capture(...args: Parameters<ClientErrorReporter["capture"]>) {
      if (reporter) {
        try {
          reporter.capture(...args);
        } catch {
          /* Reporting must never fail a product operation. */
        }
      } else if (enabled && pending.length < 20) pending.push(args);
    },
    install(next: ClientErrorReporter | undefined) {
      reporter = next;
      if (next)
        for (const args of pending.splice(0)) {
          try {
            next.capture(...args);
          } catch {
            /* Continue draining independent reports. */
          }
        }
      else pending = [];
      enabled = next !== undefined;
    },
    reset() {
      reporter = undefined;
      pending = [];
      enabled = true;
    },
  };
}

/** Client transport correlation, with no Node or SDK dependency. */
export function clientCorrelationHeaders(
  randomUUID: () => string = correlationUUID,
): Record<string, string> {
  const traceId = randomUUID().replaceAll("-", "");
  const spanId = randomUUID().replaceAll("-", "").slice(0, 16);
  return { "x-request-id": randomUUID(), traceparent: `00-${traceId}-${spanId}-01` };
}

export function responseCorrelation(headers: {
  get(name: string): string | null;
}): Record<string, string> {
  const result: Record<string, string> = {};
  const requestId = headers.get("x-request-id");
  const traceparent = headers.get("traceparent");
  if (requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) result["request.id"] = requestId;
  const match = /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/.exec(traceparent ?? "");
  if (match) result["trace.id"] = match[1]!;
  return result;
}

function correlationUUID(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Correlation IDs are opaque labels, never credentials or authorization capabilities.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

/** Native SDKs cannot run the JavaScript filter on native crashes; the API is their collector. */
export function nativeMonitoringDsn(
  base: string,
  dsn: string,
  surface: "mobile" | "desktop",
): string {
  const collector = new URL(dsn);
  const target = new URL(base);
  target.username = collector.username;
  target.password = "";
  target.search = "";
  target.hash = "";
  target.pathname = `${target.pathname.replace(/\/$/, "")}/api/monitoring/native/${surface}/0`;
  return target.href;
}
