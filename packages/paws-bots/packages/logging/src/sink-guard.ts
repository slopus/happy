import { redactSensitiveText } from "./redaction.js";

const WINDOW_MS = 30_000;
let lastReportAt = 0;
let suppressed = 0;
let failures = 0;
let lastFailureAt: number | null = null;

export function logSinkHealth(now = Date.now()) {
  return {
    failures,
    lastFailureAt,
    degraded: lastFailureAt !== null && now - lastFailureAt < 300_000,
  };
}

export function reportSinkError(error: unknown): void {
  const now = Date.now();
  failures += 1;
  lastFailureAt = now;
  if (now - lastReportAt < WINDOW_MS) {
    suppressed += 1;
    return;
  }
  const extra = suppressed > 0 ? ` (${suppressed} suppressed)` : "";
  suppressed = 0;
  lastReportAt = now;
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`log sink failed${extra}`, redactSensitiveText(message));
}

export function guardedWrite(write: () => void | Promise<void>): void {
  try {
    const result = write();
    if (result && typeof result.then === "function") {
      void result.catch(reportSinkError);
    }
  } catch (error) {
    reportSinkError(error);
  }
}

export async function guardedFlush(flush?: () => void | Promise<void>): Promise<void> {
  if (!flush) return;
  try {
    await flush();
  } catch (error) {
    reportSinkError(error);
  }
}
