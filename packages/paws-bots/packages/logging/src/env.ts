import { createConsoleSink } from "./console-sink.js";
import { createLogger } from "./logger.js";
import type { LogFormat, Logger, LogLevel, LogSink } from "./types.js";
import { LOG_LEVELS } from "./types.js";

export interface ResolvedLogEnv {
  level: LogLevel;
  format: LogFormat;
}

function isLogLevel(value: string): value is LogLevel {
  return value in LOG_LEVELS;
}

export function resolveLogEnv(source: NodeJS.ProcessEnv = process.env): ResolvedLogEnv {
  const rawLevel = source.LOG_LEVEL?.trim().toLowerCase();
  const level = rawLevel && isLogLevel(rawLevel) ? rawLevel : "info";
  const rawFormat = source.LOG_FORMAT?.trim().toLowerCase();
  const format: LogFormat =
    rawFormat === "json" || rawFormat === "pretty"
      ? rawFormat
      : source.NODE_ENV === "production"
        ? "json"
        : "pretty";
  return { level, format };
}

export function createServiceLogger(options: {
  service: string;
  env?: NodeJS.ProcessEnv;
  extraSinks?: LogSink[];
}): Logger {
  const resolved = resolveLogEnv(options.env);
  return createLogger({
    service: options.service,
    level: resolved.level,
    sinks: [createConsoleSink({ format: resolved.format }), ...(options.extraSinks ?? [])],
  });
}

export const SERVICE_NAMES = {
  api: "rakazo-api",
  worker: "rakazo-worker",
  supervisor: "rakazo-sandbox-supervisor",
  updater: "rakazo-updater",
} as const;
