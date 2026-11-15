import type { MiddlewareHandler } from "hono";
import { enrichLogContext, getLogContext } from "./context.js";
import { correlationBindings, establishRequestCorrelation } from "./correlation.js";
import { formatTraceparent } from "./ids.js";
import { getLogger } from "./logger.js";
import type { Logger } from "./types.js";

export function requestLogging(logger?: Logger): MiddlewareHandler {
  return async (c, next) => {
    const log = logger ?? getLogger();
    const correlation = establishRequestCorrelation({
      requestId: c.req.header("x-request-id"),
      traceparent: c.req.header("traceparent"),
    });
    c.header("x-request-id", correlation.requestId);
    c.header("traceparent", formatTraceparent(correlation.traceId, correlation.spanId));
    const started = performance.now();
    return log.withContext(correlationBindings(correlation), async () => {
      let thrown: unknown;
      try {
        await next();
      } catch (error) {
        thrown = error;
        if (!c.error) throw error;
      } finally {
        const failure = c.error ?? thrown;
        const context = getLogContext();
        // An expected failure was already logged where it was recognised.
        if (failure && !context["error.expected"]) log.error("http.request.failed", failure);
        const status = failure && c.res.status < 400 ? 500 : c.res.status;
        // A client that disconnected never sees the status, so its 5xx is not a server failure.
        const level =
          status >= 500 && !c.req.raw.signal.aborted && !context["error.expected"]
            ? "error"
            : status >= 400
              ? "warn"
              : "info";
        log[level]("http.request.completed", {
          // Completion records stay searchable without creating a second collector issue.
          "error.report": !failure && !context["error.reported"],
          "http.method": c.req.method,
          "http.route": matchedRoute(c.req.path, c.req.routePath),
          "http.status": status,
          "http.duration_ms": Math.round(performance.now() - started),
        });
      }
    });
  };
}

/**
 * The handler answers 5xx for a condition it already logged as a warning (a provider outage, the
 * user's own provider account), so the request's completion is a warning too, not a report.
 */
export function markExpectedFailure(): void {
  enrichLogContext({ "error.expected": true });
}

function matchedRoute(path: string, routePath: string): string {
  if (routePath && routePath !== "/*") return routePath;
  return path;
}
