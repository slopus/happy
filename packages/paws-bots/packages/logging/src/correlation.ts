import { getLogContext } from "./context.js";
import {
  formatTraceparent,
  generateRequestId,
  generateSpanId,
  generateTraceId,
  isValidRequestId,
  parseTraceparent,
} from "./ids.js";

export interface RequestCorrelation {
  requestId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export function establishRequestCorrelation(headers: {
  requestId?: string | undefined;
  traceparent?: string | undefined;
}): RequestCorrelation {
  const incoming = parseTraceparent(headers.traceparent);
  const requestId = isValidRequestId(headers.requestId) ? headers.requestId : generateRequestId();
  const traceId = incoming?.traceId ?? generateTraceId();
  const spanId = generateSpanId();
  return {
    requestId,
    traceId,
    spanId,
    parentSpanId: incoming?.spanId,
  };
}

export function correlationBindings(correlation: RequestCorrelation): Record<string, string> {
  const bindings: Record<string, string> = {
    "request.id": correlation.requestId,
    "trace.id": correlation.traceId,
    "span.id": correlation.spanId,
  };
  if (correlation.parentSpanId) bindings["parent.span.id"] = correlation.parentSpanId;
  return bindings;
}

export function outgoingCorrelationHeaders(): Record<string, string> {
  const ctx = getLogContext();
  const traceId =
    typeof ctx["trace.id"] === "string" && ctx["trace.id"].length === 32
      ? ctx["trace.id"]
      : generateTraceId();
  const spanId = generateSpanId();
  return {
    "x-request-id": generateRequestId(),
    traceparent: formatTraceparent(traceId, spanId),
  };
}
