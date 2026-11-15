import { enrichLogContext, getLogContext, runWithLogContext } from "./context.js";
import { redactBindings, redactSensitiveText } from "./redaction.js";
import { markReportedError } from "./reported-errors.js";
import { serializeError } from "./serialize-error.js";
import { guardedFlush, guardedWrite } from "./sink-guard.js";
import type {
  CreateLoggerOptions,
  EmitLevel,
  LogBindings,
  LogEvent,
  Logger,
  LogLevel,
  LogSink,
} from "./types.js";
import { LOG_LEVELS } from "./types.js";

const RESERVED = new Set(["timestamp", "level", "message", "error", "service.name"]);
const DEFAULT_FLUSH_MS = 2_000;

class LoggerImpl implements Logger {
  readonly level: LogLevel;
  private readonly service: string;
  private readonly sinks: LogSink[];
  private readonly localBindings: LogBindings;

  constructor(options: CreateLoggerOptions) {
    this.service = options.service;
    this.level = options.level ?? "info";
    this.sinks = options.sinks;
    this.localBindings = options.bindings ?? {};
  }

  debug(message: string, bindings?: LogBindings): void {
    this.emit("debug", message, bindings);
  }

  info(message: string, bindings?: LogBindings): void {
    this.emit("info", message, bindings);
  }

  warn(message: string, bindings?: LogBindings): void {
    this.emit("warn", message, bindings);
  }

  error(message: string, errorOrBindings?: unknown, bindings?: LogBindings): void {
    if (errorOrBindings === undefined) {
      this.emit("error", message);
      return;
    }
    if (isPlainBindings(errorOrBindings)) {
      this.emit("error", message, { ...errorOrBindings, ...bindings });
      return;
    }
    this.emit("error", message, bindings, errorOrBindings);
  }

  child(bindings: LogBindings): Logger {
    return new LoggerImpl({
      service: this.service,
      level: this.level,
      sinks: this.sinks,
      bindings: { ...this.localBindings, ...bindings },
    });
  }

  withContext<T>(bindings: LogBindings, fn: () => T): T {
    return runWithLogContext(bindings, fn);
  }

  enrich(bindings: LogBindings): void {
    enrichLogContext(bindings);
  }

  async flush(options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_FLUSH_MS;
    const flushing = Promise.all(this.sinks.map((sink) => guardedFlush(sink.flush?.bind(sink))));
    await Promise.race([
      flushing,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs).unref?.();
      }),
    ]);
  }

  private emit(level: EmitLevel, message: string, bindings?: LogBindings, error?: unknown): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;
    const combined = { ...this.localBindings, ...getLogContext(), ...bindings };
    const merged = redactBindings(combined);
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      message: redactSensitiveText(message),
      "service.name": this.service,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (RESERVED.has(key) || value === undefined) continue;
      event[key] = value;
    }
    // A failure passed as an `error` binding, at any level, is serialized like `error()`'s.
    const failure = error ?? combined.error;
    if (failure !== undefined) event.error = serializeError(failure);
    if (level === "error" && merged["error.report"] !== false) {
      markReportedError(failure);
      enrichLogContext({ "error.reported": true });
    }
    for (const sink of this.sinks) {
      guardedWrite(() => sink.write(event));
    }
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return new LoggerImpl(options);
}

function isPlainBindings(value: unknown): value is LogBindings {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value) || value instanceof Error) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

let installed: Logger = createLogger({
  service: "rakazo",
  level: "off",
  sinks: [],
});

export function installLogger(logger: Logger): void {
  installed = logger;
}

export function getLogger(): Logger {
  return installed;
}
