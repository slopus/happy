import { describe, expect, it, vi } from "vitest";
import {
  clientCorrelationHeaders,
  createClientErrorReporter,
  responseCorrelation,
  sanitizedError,
  sanitizeMonitoringBreadcrumb,
  sanitizeMonitoringEvent,
  scrubMonitoringText,
  stripMonitoringUrl,
} from "./monitoring.js";

describe("client monitoring contract", () => {
  it.each([
    ["C:\\Users\\Example User\\app.js", "[user]\\app.js"],
    ["c:\\users\\Example Middle User\\app.js:12:3", "[user]\\app.js:12:3"],
    ["C:\\Users\\Example\\app.js", "[user]\\app.js"],
    ["C:\\Users\\Example User", "[user]"],
    ["C:\\Users\\Example User\n at next (app.js:2:1)", "[user]\n at next (app.js:2:1)"],
    ["C:\\Users\\Example User\r\n at next (app.js:2:1)", "[user]\r\n at next (app.js:2:1)"],
    ["C:/Users/Example User/app.js", "[user]/app.js"],
    ["c:/users/Example Middle User/app.js:12:3", "[user]/app.js:12:3"],
  ])("redacts the complete Windows profile in %j", (input, expected) => {
    expect(scrubMonitoringText(input)).toBe(expected);
  });

  it.each([
    ["C:\\Users\\Example -> C:\\Users\\Other\\app.js", "[user][user]\\app.js"],
    ["C:\\Users\\Example User -> d:\\users\\Other User\\app.js", "[user][user]\\app.js"],
    [
      "C:\\Users\\Example -> D:\\Users\\Other -> e:\\users\\Third User\\app.js",
      "[user][user][user]\\app.js",
    ],
    [
      "C:\\Users\\Example User\\first.js -> D:\\Users\\Other User\\second.js",
      "[user]\\first.js -> [user]\\second.js",
    ],
    ["C:\\Users\\Example User -> D:\\build\\app.js", "[user]D:\\build\\app.js"],
    ["C:/Users/Example -> d:/users/Other User/app.js", "[user][user]/app.js"],
  ])("keeps later drive prefixes available for redaction in %j", (input, expected) => {
    expect(scrubMonitoringText(input)).toBe(expected);
  });

  it("scrubs every Windows profile in same-line error and monitoring messages", () => {
    const message = "C:\\Users\\Example -> C:\\Users\\Other\\app.js";
    expect(sanitizedError(message).message).toBe("[user][user]\\app.js");
    expect(sanitizeMonitoringEvent({ message }).message).toBe("[user][user]\\app.js");
  });

  it("scrubs spaced Windows profiles in errors without changing the original", () => {
    const path = "C:\\Users\\Example User\\app.js:12:3";
    const source = new Error(`Failed at ${path}`, { cause: new Error(path) });
    source.stack = `Error: Failed at ${path}\n at work (${path})`;
    Object.assign(source, { meta: { path } });
    const safe = sanitizedError(source);
    expect(safe.message).toBe("Failed at [user]\\app.js:12:3");
    expect(safe.stack).toBe("Error: Failed at [user]\\app.js:12:3\n at work ([user]\\app.js:12:3)");
    expect((safe.cause as Error).message).toBe("[user]\\app.js:12:3");
    expect((safe as Error & { meta: unknown }).meta).toEqual({ path: "[user]\\app.js:12:3" });
    expect(source.message).toBe(`Failed at ${path}`);
    expect(source.stack).toContain(path);
  });

  it("scrubs spaced Windows profiles from monitoring messages and frames", () => {
    const path = "C:\\Users\\Example User\\app.js";
    const result = sanitizeMonitoringEvent({
      message: `Failed at ${path}`,
      exception: {
        values: [{ value: path, stacktrace: { frames: [{ filename: path, abs_path: path }] } }],
      },
    });
    expect(result.message).toBe("Failed at [user]\\app.js");
    expect(result.exception.values[0]?.value).toBe("[user]\\app.js");
    expect(result.exception.values[0]?.stacktrace.frames[0]).toEqual({
      filename: "[user]\\app.js",
      abs_path: "[user]\\app.js",
    });
  });

  it("bounds startup reports, drains once, and clears disabled or previous-server reports", () => {
    const reporter = createClientErrorReporter();
    const capture = vi.fn();
    for (let i = 0; i < 30; i++) reporter.capture(new Error("startup"), "react.render");
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.reset();
    reporter.capture(new Error("old server"), "react.render");
    reporter.reset();
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
    reporter.install(undefined);
    reporter.capture(new Error("disabled"), "react.render");
    reporter.install({ capture });
    expect(capture).toHaveBeenCalledTimes(20);
  });

  it("scrubs credentials, identity and paths while preserving stack and cause", () => {
    const source = new Error("Bearer abc.def", { cause: new Error("password=secret") });
    source.stack = "Error: Bearer abc.def\n at work (/Users/example/app.js:12:3)";
    const safe = sanitizedError(source);
    expect(safe.stack).toContain("/[user]/app.js:12:3");
    expect(safe.stack).not.toContain("abc.def");
    expect((safe.cause as Error).message).not.toContain("secret");
    expect(source.message).toBe("Bearer abc.def");
    source.cause = source;
    expect(() => sanitizedError(source)).not.toThrow();
  });

  it("only sends the server-minted user and sanitized diagnostic fields", () => {
    const result = sanitizeMonitoringEvent(
      {
        request: {
          url: "https://app.example.com/a?token=x",
          headers: { authorization: "secret" },
          data: "private",
        },
        user: { id: "raw-account", email: "private@example.com" },
        extra: { prompt: "private" },
        breadcrumbs: [{ message: "private" }],
        server_name: "private-machine",
        exception: {
          values: [
            {
              value: "Bearer abc.def",
              stacktrace: {
                frames: [{ filename: "/home/example/a.js?token=x", vars: { secret: "x" } }],
              },
            },
          ],
        },
      },
      "a".repeat(64),
    );
    expect(result.user).toEqual({ id: "a".repeat(64), ip_address: null });
    expect(JSON.stringify(result)).not.toMatch(/private|raw-account|abc.def|example\/a|token=x/);
    expect(sanitizeMonitoringEvent({ user: undefined }, "raw-user").user).toEqual({
      ip_address: null,
    });
  });

  it("keeps a shared page's link out of reported URLs", () => {
    expect(stripMonitoringUrl("https://app.example.com/p/q3-plan-Zm9vYmFy_-x?x=1")).toBe(
      "https://app.example.com/p/[Redacted]",
    );
    expect(stripMonitoringUrl("/api/v1/pages/shared/Zm9vYmFy_-x")).toBe(
      "/api/v1/pages/shared/[Redacted]",
    );
    expect(stripMonitoringUrl("https://app.example.com/app/p/page1")).toBe(
      "https://app.example.com/app/p/page1",
    );
  });

  it("keeps a shared page's link out of reported error text", () => {
    const token = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9";
    const error = new Error(`Could not load https://app.example.com/p/plan-${token}`);
    error.stack = `Error: at fetch (/api/v1/pages/shared/${token})`;
    error.cause = new Error(`retry /p/${token}`);
    expect(JSON.stringify(sanitizedError(error), ["message", "stack", "cause"])).not.toContain(
      token,
    );
    expect(scrubMonitoringText(`GET /p/${token} failed`)).toBe("GET /p/[Redacted] failed");
  });

  it("uses valid W3C headers shared by client errors and the API", () => {
    const headers = clientCorrelationHeaders(() => "12345678-1234-4234-9234-123456789abc");
    expect(headers.traceparent).toBe("00-12345678123442349234123456789abc-1234567812344234-01");
    const tags = responseCorrelation(new Headers(headers));
    expect(tags).toEqual({
      "trace.id": "12345678123442349234123456789abc",
      "request.id": "12345678-1234-4234-9234-123456789abc",
    });
    expect(
      responseCorrelation(new Headers({ traceparent: "secret", "x-request-id": "Bearer secret" })),
    ).toEqual({});
  });

  it("keeps only the shape of breadcrumbs, never their content", () => {
    const crumb = sanitizeMonitoringBreadcrumb;
    expect(
      crumb({
        type: "http",
        category: "xhr",
        level: "info",
        timestamp: 1_700_000_000,
        message: "private",
        data: {
          method: "POST",
          status_code: 502,
          url: "https://app.example.com/rpc/threads.send/clx9abc123def?token=secret#frag",
          request_body_size: 10,
          body: "private",
          headers: { authorization: "Bearer secret" },
        },
      }),
    ).toEqual({
      type: "http",
      category: "xhr",
      level: "info",
      timestamp: 1_700_000_000,
      data: { method: "POST", status_code: 502, url: "/rpc/threads.send/:id" },
    });
    expect(
      crumb({ category: "http", data: { url: "/api/v1/bots/1f3e9a7b/webhook" } })?.data,
    ).toEqual({ url: "/api/v1/bots/:id/webhook" });
    expect(
      crumb({ category: "http", data: { url: "https://images.example.com/private-photo.png" } })
        ?.data,
    ).toEqual({ url: "[external]" });
    expect(
      crumb({
        category: "device.event",
        level: "warning",
        message: "Low memory",
        data: { action: "LOW_MEMORY", note: "private" },
      }),
    ).toEqual({ category: "device.event", level: "warning", data: { action: "LOW_MEMORY" } });
    expect(crumb({ category: "system", timestamp: "2026-01-01T00:00:00.000Z" })).toEqual({
      category: "system",
      timestamp: 1_767_225_600,
    });
    expect(
      crumb({ category: "navigation", data: { to: "chat", from: "Private chat title" } }),
    ).toEqual({ category: "navigation", data: { to: "chat" } });
    for (const category of ["console", "touch", "ui.click", "ui.input", "sentry.event", "query"])
      expect(crumb({ category, message: "private", data: { text: "private" } })).toBeNull();
    expect(crumb({ message: "private" })).toBeNull();
    expect(crumb("private")).toBeNull();
  });
});
