import { describe, expect, it } from "vitest";
import {
  errorStatus,
  isRetryableError,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  RECONNECT_SPREAD_MS,
  reconnectDelayMs,
  retryDelayMs,
} from "./retry-policy.js";

const withStatus = (status: number) => Object.assign(new Error("failed"), { status });

describe("retry policy", () => {
  it("retries failures without a response", () => {
    expect(isRetryableError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableError(new Error("Request timed out"))).toBe(true);
    expect(isRetryableError(undefined)).toBe(true);
  });

  it("retries server errors, rate limits, and request timeouts", () => {
    for (const status of [503, 429, 408]) {
      expect(isRetryableError(withStatus(status))).toBe(true);
    }
  });

  it("stops on every other client error", () => {
    for (const status of [401, 404, 426]) {
      expect(isRetryableError(withStatus(status))).toBe(false);
    }
  });

  it("reads only integer statuses", () => {
    expect(errorStatus({ status: 404 })).toBe(404);
    expect(errorStatus({ status: "404" })).toBeUndefined();
    expect(errorStatus(null)).toBeUndefined();
  });

  it("parses Retry-After seconds and dates, bounded", () => {
    const now = Date.parse("2026-10-22T10:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 22 Oct 2026 10:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("Thu, 22 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("999999", now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("waits at least the caller's backoff and at most the cap when the server asks", () => {
    const random = () => 0;
    expect(retryDelayMs({ status: 429, retryAfterMs: 10_000 }, 250, random)).toBe(10_000);
    expect(retryDelayMs({ status: 429, retryAfterMs: 0 }, 250, random)).toBe(250);
    expect(retryDelayMs({ status: 429, retryAfterMs: 10 * MAX_RETRY_AFTER_MS }, 250, random)).toBe(
      MAX_RETRY_AFTER_MS,
    );
  });

  it("jitters the backoff after a failure, between half and all of it", () => {
    expect(retryDelayMs(new Error("x"), 1_000, () => 0)).toBe(1_000);
    expect(retryDelayMs(new Error("x"), 1_000, () => 0.5)).toBe(750);
    expect(retryDelayMs(new Error("x"), 1_000, () => 1)).toBe(500);
  });

  it("keeps the caller's interval when nothing failed", () => {
    expect(retryDelayMs(undefined, 15_000, () => 0)).toBe(15_000);
  });

  it("spreads a stream reconnect across a few seconds, keeping the server's ask", () => {
    expect(reconnectDelayMs(undefined, () => 0)).toBe(0);
    expect(reconnectDelayMs(new Error("closed"), () => 0.5)).toBe(RECONNECT_SPREAD_MS / 2);
    expect(reconnectDelayMs(undefined, () => 1)).toBe(RECONNECT_SPREAD_MS);
    expect(reconnectDelayMs({ status: 503, retryAfterMs: 30_000 }, () => 1)).toBe(30_000);
  });
});
