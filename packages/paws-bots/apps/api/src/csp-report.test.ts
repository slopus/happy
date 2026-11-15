import { CSP_REPORT_PATH } from "@rakazo/contracts/content-security-policy";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cspReportRoutes, MAX_CSP_REPORT_BYTES, parseCspReports } from "./csp-report.js";

const LEGACY = {
  "csp-report": {
    "document-uri": "https://app.example.com/app/bot-1?token=secret#private",
    referrer: "https://app.example.com/sign-in?code=secret",
    "violated-directive": "script-src-elem 'self'",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'",
    disposition: "enforce",
    "blocked-uri": "https://cdn.example.net/tag.js?key=secret",
    "source-file": "https://app.example.com/assets/app.js?v=1#frag",
    "script-sample": "private user text",
    "status-code": 200,
  },
};

const REPORTING_API = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://app.example.com/app?invite=secret",
    user_agent: "Browser/1.0",
    body: {
      documentURL: "https://app.example.com/app/artifacts?invite=secret",
      blockedURL: "inline",
      effectiveDirective: "style-src-attr",
      originalPolicy: "default-src 'self'",
      sample: "color: red",
      disposition: "report",
      statusCode: 200,
    },
  },
  { type: "deprecation", body: { id: "x", effectiveDirective: "script-src" } },
  {
    type: "csp-violation",
    body: {
      documentURL: "https://app.example.com/",
      blockedURL: "data:image/png;base64,AAAA",
      effectiveDirective: "img-src",
    },
  },
];

let sink: TestSink;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});

afterEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
});

function post(
  app: ReturnType<typeof cspReportRoutes>,
  body: string,
  type = "application/csp-report",
) {
  return app.request(CSP_REPORT_PATH, {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
}

describe("CSP report parsing", () => {
  it("reads the legacy report-uri body and keeps no query, fragment or sample", () => {
    expect(parseCspReports(LEGACY)).toEqual([
      {
        directive: "script-src-elem",
        blocked: "https://cdn.example.net",
        page: "/app/bot-1",
        source: "https://app.example.com/assets/app.js",
        disposition: "enforce",
      },
    ]);
    expect(JSON.stringify(parseCspReports(LEGACY))).not.toMatch(/secret|private|frag|v=1/);
  });

  it("never logs the link token of a shared page the report came from", () => {
    const token = "a".repeat(43);
    const [violation] = parseCspReports([
      {
        type: "csp-violation",
        body: {
          documentURL: `https://app.example.com/p/q3-plan-${token}`,
          blockedURL: "inline",
          sourceFile: `https://app.example.com/p/q3-plan-${token}?x=1`,
          effectiveDirective: "script-src-elem",
        },
      },
    ]);
    expect(violation?.page).toBe("/p/[Redacted]");
    expect(JSON.stringify(violation)).not.toContain(token);
  });

  it("falls back to violated-directive when an older browser omits the effective one", () => {
    const report = { "csp-report": { ...LEGACY["csp-report"], "effective-directive": undefined } };
    expect(parseCspReports(report)[0]?.directive).toBe("script-src-elem");
  });

  it("reads Reporting API batches and skips other report types", () => {
    expect(parseCspReports(REPORTING_API)).toEqual([
      {
        directive: "style-src-attr",
        blocked: "inline",
        page: "/app/artifacts",
        disposition: "report",
      },
      { directive: "img-src", blocked: "data", page: "/", disposition: "enforce" },
    ]);
  });

  it("reads at most twenty violations from one batch", () => {
    const batch = Array.from({ length: 25 }, (_, index) => ({
      type: "csp-violation",
      body: { documentURL: `https://app.example.com/${index}`, effectiveDirective: "img-src" },
    }));
    expect(parseCspReports(batch)).toHaveLength(20);
  });

  it("reports blob and other non-network URLs by scheme alone", () => {
    const [violation] = parseCspReports([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://app.example.com/",
          blockedURL: "blob:https://app.example.com/1b2c",
          effectiveDirective: "worker-src",
        },
      },
    ]);
    expect(violation?.blocked).toBe("blob");
  });

  it("redacts what survives stripping and drops malformed entries", () => {
    const [violation] = parseCspReports({
      "csp-report": {
        "document-uri": "https://app.example.com/u/ada@example.com",
        "effective-directive": "connect-src",
        "blocked-uri": "wss://socket.example.com/live?ticket=1",
      },
    });
    expect(violation).toMatchObject({
      page: "/u/[Redacted]",
      blocked: "wss://socket.example.com",
    });
    expect(parseCspReports({ "csp-report": { "effective-directive": "Bad!" } })).toEqual([]);
    expect(parseCspReports(null)).toEqual([]);
    expect(parseCspReports({ other: true })).toEqual([]);
    expect(parseCspReports([{ type: "csp-violation", body: "nope" }])).toEqual([]);
  });
});

describe("CSP report endpoint", () => {
  it("logs one warn line per violation for both formats", async () => {
    const app = cspReportRoutes(() => "203.0.113.1");
    expect((await post(app, JSON.stringify(LEGACY))).status).toBe(204);
    expect(
      (await post(app, JSON.stringify(REPORTING_API), "application/reports+json")).status,
    ).toBe(204);
    const lines = sink.events.filter((event) => event.message === "csp.violation");
    expect(lines).toHaveLength(3);
    expect(lines.every((event) => event.level === "warn")).toBe(true);
    expect(lines[0]).toMatchObject({
      "csp.directive": "script-src-elem",
      "csp.blocked": "https://cdn.example.net",
      "csp.page": "/app/bot-1",
      "csp.disposition": "enforce",
      "csp.source": "https://app.example.com/assets/app.js",
    });
    expect(JSON.stringify(sink.events)).not.toMatch(/secret|private user text/);
  });

  it("logs a burst of the same violation once per window", async () => {
    let now = 0;
    const app = cspReportRoutes(
      () => "203.0.113.2",
      () => now,
    );
    for (let index = 0; index < 5; index++) await post(app, JSON.stringify(LEGACY));
    expect(sink.events.filter((event) => event.message === "csp.violation")).toHaveLength(1);
    now = 60_000;
    await post(app, JSON.stringify(LEGACY));
    expect(sink.events.filter((event) => event.message === "csp.violation")).toHaveLength(2);
  });

  it("rate-limits each client address separately", async () => {
    let ip = "203.0.113.3";
    let now = 0;
    const app = cspReportRoutes(
      () => ip,
      () => now,
    );
    for (let index = 0; index < 30; index++) {
      expect((await post(app, JSON.stringify(LEGACY))).status).toBe(204);
    }
    const limited = await post(app, JSON.stringify(LEGACY));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    ip = "203.0.113.4";
    expect((await post(app, JSON.stringify(LEGACY))).status).toBe(204);
    ip = "203.0.113.3";
    now = 60_000;
    expect((await post(app, JSON.stringify(LEGACY))).status).toBe(204);
  });

  it("refuses oversized, unparseable and non-report bodies", async () => {
    const app = cspReportRoutes(() => "203.0.113.5");
    expect((await post(app, "x".repeat(MAX_CSP_REPORT_BYTES + 1))).status).toBe(413);
    expect((await post(app, "not json")).status).toBe(400);
    expect((await post(app, JSON.stringify(LEGACY), "text/plain")).status).toBe(415);
    expect((await post(app, JSON.stringify(LEGACY), "application/json")).status).toBe(204);
    expect(
      (
        await app.request(CSP_REPORT_PATH, {
          method: "POST",
          headers: { "content-type": "application/csp-report; charset=utf-8" },
          body: JSON.stringify(LEGACY),
        })
      ).status,
    ).toBe(204);
  });
});
