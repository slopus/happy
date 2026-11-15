import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, expect, it, vi } from "vitest";
import { createPiTelemetryExporter, otelPiContext } from "./pi-telemetry-otel.js";

afterEach(() => vi.unstubAllEnvs());

it("exports OTLP/HTTP with standard endpoint, headers and service name on shutdown", async () => {
  const received: Array<{ url?: string; authorization?: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    // A local tool can probe any listening loopback port; only OTLP exports are recorded.
    if (request.method !== "POST" || request.url !== "/v1/traces") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ url: request.url, authorization: request.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  vi.stubEnv(
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
  vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer%20fake-fixture-token");
  vi.stubEnv("OTEL_SERVICE_NAME", "fixture-worker");
  const exporter = await createPiTelemetryExporter();
  try {
    await exporter.context.startSpan(
      {
        name: "pi.ai.request",
        attributes: { "pi.ai.model": "fixture", "pi.ai.prompt": "private" },
      },
      async () => {},
    );
    await exporter.shutdown();
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("/v1/traces");
    expect(received[0]?.authorization).toBe("Bearer fake-fixture-token");
    const payload = JSON.parse(received[0]!.body);
    expect(payload.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "fixture-worker" },
    });
    expect(received[0]?.body).toContain("pi.ai.request");
    expect(received[0]?.body).not.toMatch(/private|fake-fixture-token/);
  } finally {
    await exporter.shutdown().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("links Pi spans to the OTel spans this bridge started, before and after start", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const context = otelPiContext(provider.getTracer("test"), false);
  const first = await context.startSpan({ name: "first" }, (span) => span);
  await context.startSpan(
    {
      name: "second",
      links: [
        { context: first, attributes: { "pi.ai.model": "fixture", "pi.ai.prompt": "private" } },
        { context: NOOP_TELEMETRY_CONTEXT },
      ],
    },
    (span) => {
      span.addLink({ context: first });
      span.addLink({ context: NOOP_TELEMETRY_CONTEXT });
    },
  );
  const [firstSpan, secondSpan] = exporter.getFinishedSpans();
  expect(secondSpan?.links).toEqual([
    {
      context: firstSpan?.spanContext(),
      attributes: { "pi.ai.model": "fixture" },
      droppedAttributesCount: 0,
    },
    { context: firstSpan?.spanContext(), attributes: {}, droppedAttributesCount: 0 },
  ]);
  await provider.shutdown();
});
