export const LOG_LEVELS = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  off: 100,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;
export type EmitLevel = Exclude<LogLevel, "off">;
export type LogFormat = "json" | "pretty";
export type LogBindings = Record<string, unknown>;

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  meta?: Record<string, unknown>;
  stack?: string;
  cause?: SerializedError;
}

export interface LogEvent {
  timestamp: string;
  level: EmitLevel;
  message: string;
  "service.name": string;
  error?: SerializedError;
  [key: string]: unknown;
}

export interface LogSink {
  write(event: LogEvent): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, bindings?: LogBindings): void;
  info(message: string, bindings?: LogBindings): void;
  warn(message: string, bindings?: LogBindings): void;
  error(message: string, errorOrBindings?: unknown, bindings?: LogBindings): void;
  child(bindings: LogBindings): Logger;
  withContext<T>(bindings: LogBindings, fn: () => T): T;
  enrich(bindings: LogBindings): void;
  flush(options?: { timeoutMs?: number }): Promise<void>;
}

export interface CreateLoggerOptions {
  service: string;
  level?: LogLevel;
  sinks: LogSink[];
  bindings?: LogBindings;
}

export interface JobCorrelation {
  jobId: string;
  traceId: string;
  parentSpanId?: string;
}

export const JOB_CORRELATION_VERSION = 1;
