import { randomBytes, randomUUID } from "node:crypto";

const REQUEST_ID = /^[\w.:-]{1,128}$/;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export function generateRequestId(): string {
  return randomUUID();
}

export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

export function isValidRequestId(value: string | undefined): value is string {
  return Boolean(value && REQUEST_ID.test(value));
}

export interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(value: string | undefined): TraceParent | undefined {
  if (!value) return undefined;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;
  const traceId = match[1]!;
  const spanId = match[2]!;
  const flags = match[3]!;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, flags };
}

export function formatTraceparent(traceId: string, spanId: string, flags = "01"): string {
  return `00-${traceId}-${spanId}-${flags}`;
}
