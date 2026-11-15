import { CSP_REPORT_PATH } from "@rakazo/contracts/content-security-policy";
import { getLogger, redactSensitiveText } from "@rakazo/logging";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import { throttleKey, windowCounter } from "./window-counter.js";

/**
 * Content-Security-Policy violation reports. Browsers post them without credentials, so the
 * endpoint is open; a per-address budget, a body cap and burst de-duplication keep it cheap.
 * Each violation becomes one warn log line, which reaches whichever log sink is configured.
 */
export const MAX_CSP_REPORT_BYTES = 64 * 1024;
const MAX_VIOLATIONS_PER_REQUEST = 20;
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 30;
const REPORT_TYPES = ["application/csp-report", "application/reports+json", "application/json"];
// Values a browser reports in place of a URL for inline code, eval and similar sources.
const KEYWORD = /^[a-z][a-z-]*$/;
const MAX_FIELD_LENGTH = 512;

export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  source?: string;
  disposition: "enforce" | "report";
}

/** Reads both the legacy `report-uri` body and the Reporting API batch. Malformed entries drop. */
export function parseCspReports(body: unknown): CspViolation[] {
  const entries = Array.isArray(body)
    ? body.flatMap((report) =>
        isRecord(report) && report.type === "csp-violation" && isRecord(report.body)
          ? [reportingApiFields(report.body)]
          : [],
      )
    : isRecord(body) && isRecord(body["csp-report"])
      ? [legacyFields(body["csp-report"])]
      : [];
  return entries.slice(0, MAX_VIOLATIONS_PER_REQUEST).flatMap((fields) => {
    const directive = field(fields.directive)?.split(" ", 1)[0];
    if (!directive || !KEYWORD.test(directive)) return [];
    const source = field(fields.source);
    return [
      {
        directive,
        blocked: blockedSource(field(fields.blocked)),
        page: pagePath(field(fields.page)),
        ...(source ? { source: stripUrl(source) } : {}),
        disposition: fields.disposition === "report" ? "report" : "enforce",
      },
    ];
  });
}

interface RawFields {
  directive: unknown;
  blocked: unknown;
  page: unknown;
  source: unknown;
  disposition: unknown;
}

function legacyFields(report: Record<string, unknown>): RawFields {
  return {
    directive: report["effective-directive"] ?? report["violated-directive"],
    blocked: report["blocked-uri"],
    page: report["document-uri"],
    source: report["source-file"],
    disposition: report.disposition,
  };
}

function reportingApiFields(report: Record<string, unknown>): RawFields {
  return {
    directive: report.effectiveDirective,
    blocked: report.blockedURL,
    page: report.documentURL,
    source: report.sourceFile,
    disposition: report.disposition,
  };
}

/** The origin of a blocked URL, or the keyword (inline, eval, data, blob) the browser sent. */
function blockedSource(value: string | undefined): string {
  if (!value) return "unknown";
  if (KEYWORD.test(value)) return value;
  try {
    const url = new URL(value);
    // data:, blob: and other non-network schemes report as the scheme alone.
    return /^(?:https?|wss?):$/.test(url.protocol) ? url.origin : url.protocol.slice(0, -1);
  } catch {
    return "unknown";
  }
}

/** The page path only: query strings and fragments can carry tokens. */
function pagePath(value: string | undefined): string {
  if (!value) return "unknown";
  try {
    return redactSensitiveText(new URL(value).pathname);
  } catch {
    return "unknown";
  }
}

function stripUrl(value: string): string {
  return redactSensitiveText(value.split(/[?#]/, 1)[0]!);
}

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cspReportRoutes(
  clientIp: (c: Context) => string | undefined,
  now: () => number = Date.now,
) {
  const app = new Hono();
  const requests = windowCounter(WINDOW_MS, now);
  const violations = windowCounter(WINDOW_MS, now);

  app.post(CSP_REPORT_PATH, async (c) => {
    const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!REPORT_TYPES.includes(type)) return c.body(null, 415);
    if (requests(throttleKey(clientIp(c))) > REQUESTS_PER_WINDOW) {
      return c.body(null, 429, { "retry-after": String(WINDOW_MS / 1000) });
    }
    const text = await readBoundedBody(c.req.raw, MAX_CSP_REPORT_BYTES);
    if (text === null) return c.body(null, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.body(null, 400);
    }
    for (const violation of parseCspReports(body)) {
      const key = [
        violation.directive,
        violation.blocked,
        violation.page,
        violation.source,
        violation.disposition,
      ].join(" ");
      // A page that trips the policy once usually trips it on every render; one line per minute.
      if (violations(key) > 1) continue;
      getLogger().warn("csp.violation", {
        "csp.directive": violation.directive,
        "csp.blocked": violation.blocked,
        "csp.page": violation.page,
        "csp.disposition": violation.disposition,
        ...(violation.source ? { "csp.source": violation.source } : {}),
      });
    }
    return c.body(null, 204);
  });

  return app;
}
