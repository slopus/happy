import type * as SentrySdk from "@sentry/node";
import { CORRELATION_TAG_KEYS } from "./monitoring.js";
import { isMonitoringUserId, monitoringPseudonymSecret, monitoringUserId } from "./pseudonym.js";
import { redactSensitiveText } from "./redaction.js";
import { errorSummary } from "./serialize-error.js";
import { reportSinkError } from "./sink-guard.js";
import type { LogEvent, LogSink, SerializedError } from "./types.js";

// Error reporting to any Sentry-protocol collector (GlitchTip, Sentry, Bugsink). Only error-level
// logs are reported; everything else stays with the console and Axiom sinks.

export interface SentryConfig {
  dsn: string;
  environment?: string;
  release?: string;
  /** Keys the pseudonymous user id; without it reports carry no user. */
  pseudonymSecret?: string;
}

const FLUSH_TIMEOUT_MS = 2_000;
// Model fields let issues be filtered by the provider and model that failed.
const TAG_KEYS = [...CORRELATION_TAG_KEYS, "model.provider", "model.id"] as const;
const EXTRA_KEYS = ["log.message", "error.details"] as const;

export function sentryConfigFromEnv(source: NodeJS.ProcessEnv = process.env): {
  config?: SentryConfig;
  warning?: string;
} {
  const dsn = source.SENTRY_DSN?.trim();
  if (!dsn) return {};
  if (!isValidDsn(dsn)) {
    return { warning: "Error reporting is disabled; SENTRY_DSN is not a valid DSN." };
  }
  return {
    config: {
      dsn,
      environment: source.SENTRY_ENVIRONMENT?.trim() || undefined,
      release: source.SENTRY_RELEASE?.trim() || releaseFromGitSha(source.GIT_SHA),
      pseudonymSecret: monitoringPseudonymSecret(source),
    },
  };
}

export function isValidDsn(dsn: string): boolean {
  try {
    const url = new URL(dsn);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.username) &&
      /\/[\w-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

// The SDK loads only when a sink is built (SENTRY_DSN set), so unconfigured installs never
// import it; a dynamic import of this module alone would not keep it lazy, because the
// server bundle inlines this file.
export async function createSentrySink(
  service: string,
  config: SentryConfig,
  transport?: SentrySdk.NodeOptions["transport"],
): Promise<LogSink> {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    transport: (options) => {
      const delegate = (transport ?? Sentry.makeNodeTransport)(options);
      return {
        send: async (envelope) => {
          try {
            const response = await delegate.send(envelope);
            if (
              response.statusCode !== undefined &&
              (response.statusCode < 200 || response.statusCode >= 300)
            )
              reportSinkError(new Error(`Error collector returned HTTP ${response.statusCode}`));
            return response;
          } catch (error) {
            reportSinkError(new Error("Error collector transport failed"));
            throw error;
          }
        },
        flush: (timeout) => delegate.flush(timeout),
      };
    },
    // A message-only error log would otherwise carry a stack captured inside this sink, and the
    // collector would group every such log as one issue titled after that frame.
    attachStacktrace: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    // No automatic HTTP, console, or library instrumentation: errors arrive through the logger,
    // plus uncaught exceptions. Unhandled rejections are left alone, because any listener on that
    // event stops Node from crashing.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
    ],
    beforeSend: redactEvent,
  });
  Sentry.setTag("service", service);
  return {
    write(event: LogEvent) {
      if (event.level !== "error" || event["error.report"] === false) return;
      const { "service.name": service, error } = event;
      const message = redactSensitiveText(reportTitle(event));
      Sentry.withScope((scope) => {
        scope.setTag("service", service);
        for (const key of TAG_KEYS) {
          const value = event[key];
          if (typeof value === "string" && value.length > 0 && value.length <= 200)
            scope.setTag(key, redactSensitiveText(value));
        }
        const userId = event["user.id"];
        // Only the keyed hash leaves: never the account id, and no address for the collector to infer.
        if (config.pseudonymSecret && typeof userId === "string" && userId.length > 0)
          scope.setUser({ id: monitoringUserId(config.pseudonymSecret, userId), ip_address: null });
        scope.setExtra("log.message", message);
        // Diagnostics the caller already reduced to safe fields, such as a rejected request's shape.
        const details = event["error.details"];
        if (typeof details === "string")
          scope.setExtra("error.details", redactSensitiveText(details));
        const fingerprint = event["error.fingerprint"];
        // Split on top of the stack: errors rethrown from one place stop sharing one issue.
        if (Array.isArray(fingerprint) && fingerprint.every((part) => typeof part === "string"))
          scope.setFingerprint(["{{ default }}", ...fingerprint.map(redactSensitiveText)]);
        if (error) {
          Sentry.captureException(rebuildError(error));
        } else {
          Sentry.captureMessage(message, "error");
        }
      });
    },
    async flush() {
      await Sentry.flush(FLUSH_TIMEOUT_MS);
    },
  };
}

export async function createSentrySinkFromEnv(
  service: string,
  source: NodeJS.ProcessEnv = process.env,
): Promise<{
  sink?: LogSink;
  warning?: string;
}> {
  const { config, warning } = sentryConfigFromEnv(source);
  return config ? { sink: await createSentrySink(service, config) } : { warning };
}

/** A failed request with nothing else logged groups by what answered it, not as one issue. */
function reportTitle(event: LogEvent): string {
  const route = event["http.route"];
  if (typeof route !== "string") return event.message;
  return `${event.message} ${event["http.method"]} ${route} ${event["http.status"]}`;
}

function releaseFromGitSha(sha: string | undefined): string | undefined {
  const value = sha?.trim();
  return value && value !== "unknown" ? value : undefined;
}

/** The logger hands sinks a serialized error; rebuild one Sentry can parse, cause chain included. */
function rebuildError(serialized: SerializedError): Error {
  const message = errorSummary(redactSensitiveText(serialized.message), serialized.code);
  const error = new Error(message);
  error.name = redactSensitiveText(serialized.name);
  error.stack = serialized.stack
    ? redactSensitiveText(serialized.stack)
    : `${error.name}: ${message}`;
  if (serialized.cause) error.cause = rebuildError(serialized.cause);
  return error;
}

function redactEvent(event: SentrySdk.ErrorEvent): SentrySdk.ErrorEvent {
  delete event.request;
  const userId = event.user?.id;
  event.user = isMonitoringUserId(userId) ? { id: userId, ip_address: null } : { ip_address: null };
  delete event.breadcrumbs;
  event.server_name = undefined;
  if (event.extra) {
    const extra = event.extra;
    event.extra = Object.fromEntries(
      EXTRA_KEYS.flatMap((key) =>
        typeof extra[key] === "string" ? [[key, redactSensitiveText(extra[key])]] : [],
      ),
    );
  }
  if (event.message) event.message = redactSensitiveText(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactSensitiveText(value.value);
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = redactSensitiveText(frame.filename);
      if (frame.abs_path) frame.abs_path = redactSensitiveText(frame.abs_path);
      if (frame.module) frame.module = redactSensitiveText(frame.module);
      delete frame.vars;
    }
  }
  return event;
}
