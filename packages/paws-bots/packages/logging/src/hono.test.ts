import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runWithLogContext } from "./context.js";
import { markExpectedFailure, requestLogging } from "./hono.js";
import { outgoingCorrelationHeaders, parseTraceparent } from "./index.js";
import { createLogger } from "./logger.js";
import { createTestSink } from "./test-sink.js";
import type { Logger } from "./types.js";

function appWith(logger: Logger) {
  const app = new Hono();
  app.use("*", requestLogging(logger));
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/items/:id", (c) => c.json({ id: c.req.param("id") }));
  app.get("/fail", () => {
    throw new Error("boom");
  });
  app.get("/bad", (c) => c.json({ error: "nope" }, 400));
  app.get("/crash", (c) => c.json({ error: "down" }, 500));
  app.get("/outage", (c) => {
    markExpectedFailure();
    return c.json({ error: "provider down" }, 503);
  });
  return app;
}

describe("hono request logging", () => {
  it("validates or generates request ids and returns them", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = appWith(logger);
    const generated = await app.request("/health");
    expect(generated.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const kept = await app.request("/health", { headers: { "x-request-id": "req-keep.1" } });
    expect(kept.headers.get("x-request-id")).toBe("req-keep.1");

    const rejected = await app.request("/health", { headers: { "x-request-id": "bad id\n" } });
    expect(rejected.headers.get("x-request-id")).not.toBe("bad id\n");
  });

  it("accepts valid traceparent headers and generates a child span", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = appWith(logger);
    const traceId = "a".repeat(32);
    const parent = "b".repeat(16);
    const response = await app.request("/health", {
      headers: { traceparent: `00-${traceId}-${parent}-01` },
    });
    const outgoing = parseTraceparent(response.headers.get("traceparent") ?? undefined);
    expect(outgoing?.traceId).toBe(traceId);
    expect(outgoing?.spanId).not.toBe(parent);
    expect(sink.events[0]).toMatchObject({
      "trace.id": traceId,
      "parent.span.id": parent,
    });
  });

  it("normalizes matched routes and records duration", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = appWith(logger);
    await app.request("/items/abc?secret=1");
    expect(sink.events[0]).toMatchObject({
      message: "http.request.completed",
      "http.method": "GET",
      "http.route": "/items/:id",
      "http.status": 200,
    });
    expect(typeof sink.events[0]?.["http.duration_ms"]).toBe("number");
    expect(JSON.stringify(sink.events[0])).not.toContain("secret=1");
  });

  it("uses info, warn, and error by status class", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = appWith(logger);
    await app.request("/health");
    await app.request("/bad");
    await app.request("/crash");
    expect(sink.events.map((event) => event.level)).toEqual(["info", "warn", "error"]);
  });

  it("warns for a 5xx the disconnected client never received", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const client = new AbortController();
    const app = new Hono();
    app.use("*", requestLogging(logger));
    app.get("/gone", (c) => {
      client.abort();
      return c.json({ error: "down" }, 500);
    });
    await app.request(new Request("http://localhost/gone", { signal: client.signal }));
    expect(sink.events[0]).toMatchObject({ level: "warn", "http.status": 500 });
  });

  it("isolates concurrent requests", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = new Hono();
    app.use("*", requestLogging(logger));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    app.get("/hold", async (c) => {
      started += 1;
      if (started === 1) await hold;
      return c.json({ id: c.req.header("x-request-id") });
    });
    const first = app.request("/hold", { headers: { "x-request-id": "req-a" } });
    await Promise.resolve();
    const second = app.request("/hold", { headers: { "x-request-id": "req-b" } });
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    const completed = sink.events.filter((event) => event.message === "http.request.completed");
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ "request.id": "req-a" }),
        expect.objectContaining({ "request.id": "req-b" }),
      ]),
    );
  });

  it("completes an expected 5xx as a warning", async () => {
    const sink = createTestSink();
    const app = appWith(createLogger({ service: "rakazo-api", sinks: [sink] }));
    expect((await app.request("/outage")).status).toBe(503);
    expect((await app.request("/crash")).status).toBe(500);
    expect(sink.events.map((event) => [event.level, event["http.route"]])).toEqual([
      ["warn", "/outage"],
      ["error", "/crash"],
    ]);
  });

  it("reports handler exceptions as failed requests", async () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "rakazo-api", sinks: [sink] });
    const app = appWith(logger);
    const response = await app.request("/fail");
    expect(response.status).toBe(500);
    expect(sink.events.some((event) => event.message === "http.request.failed")).toBe(true);
    expect(
      sink.events.some(
        (event) => event.message === "http.request.completed" && event.level === "error",
      ),
    ).toBe(true);
  });
});

describe("outgoing correlation headers", () => {
  it("keeps the trace id and issues a new request and span", () => {
    const headers = runWithLogContext(
      { "trace.id": "c".repeat(32), "span.id": "d".repeat(16), "request.id": "origin" },
      () => outgoingCorrelationHeaders(),
    );
    const parsed = parseTraceparent(headers.traceparent);
    expect(parsed?.traceId).toBe("c".repeat(32));
    expect(parsed?.spanId).not.toBe("d".repeat(16));
    expect(headers["x-request-id"]).not.toBe("origin");
  });
});
