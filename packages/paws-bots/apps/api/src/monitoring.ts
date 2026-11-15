import { getLogger, monitoringUserId } from "@rakazo/logging";
import { markExpectedFailure } from "@rakazo/logging/hono";
import type { MonitoringConfig } from "@rakazo/logging/monitoring";
import { Hono } from "hono";
import type { AppEnv } from "./env.js";
import { sanitizeNativeEnvelope } from "./native-monitoring.js";
import { requestBodyLimit } from "./request-body-limit.js";

/**
 * Browser error reporting. The web image is shared by every deployment, so the browser learns its
 * DSN from the API at runtime instead of at build time. Reports go back through the API tunnel:
 * same origin, so ad blockers and the collector's CORS policy do not drop them.
 */
export const MONITORING_TUNNEL_PATH = "/api/monitoring/tunnel";
export const MAX_MONITORING_ENVELOPE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const FORWARDED_RESPONSE_HEADERS = ["retry-after", "x-sentry-rate-limits"];

export type MonitoringConfigResponse = MonitoringConfig;

interface DsnTarget {
  publicKey: string;
  envelopeUrl: string;
}

export function parseDsn(dsn: string): DsnTarget | undefined {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!url.username || !projectId || !/^[\w-]+$/.test(projectId)) return undefined;
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    publicKey: url.username,
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
  };
}

export function monitoringRoutes(
  config: AppEnv["browserMonitoring"],
  fetchImpl: typeof fetch = fetch,
  sessionUserId: (request: Request) => Promise<string | undefined> = async () => undefined,
) {
  const app = new Hono();
  const target = config ? parseDsn(config.dsn) : undefined;
  if (config && !target) {
    getLogger().warn("Browser error reporting is disabled; SENTRY_BROWSER_DSN is not a valid DSN.");
  }

  app.get("/api/monitoring/config", async (c) => {
    c.header("cache-control", "no-store");
    if (!config || !target) return c.json({ dsn: null } satisfies MonitoringConfigResponse);
    const secret = config.pseudonymSecret;
    const userId = secret ? await sessionUserId(c.req.raw).catch(() => undefined) : undefined;
    return c.json({
      dsn: config.dsn,
      environment: config.environment ?? null,
      release: config.release ?? null,
      tunnel: MONITORING_TUNNEL_PATH,
      userId: secret && userId ? monitoringUserId(secret, userId) : null,
    } satisfies MonitoringConfigResponse);
  });

  app.post(MONITORING_TUNNEL_PATH, requestBodyLimit(MAX_MONITORING_ENVELOPE_BYTES), async (c) => {
    if (!target) return c.notFound();
    const envelope = new Uint8Array(await c.req.arrayBuffer());
    // Only envelopes addressed to the configured project are forwarded, so the tunnel is not an
    // open relay to arbitrary collectors.
    if (!addressedTo(envelope, target)) return c.json({ error: "Unknown DSN." }, 403);
    return forwardEnvelope(target, envelope, fetchImpl);
  });

  app.post(
    "/api/monitoring/native/:surface/api/0/envelope/",
    requestBodyLimit(MAX_MONITORING_ENVELOPE_BYTES),
    async (c) => {
      const surface = c.req.param("surface");
      if (!target || !config || (surface !== "mobile" && surface !== "desktop"))
        return c.notFound();
      let envelope: Uint8Array;
      try {
        envelope = await sanitizeNativeEnvelope(
          new Uint8Array(await c.req.arrayBuffer()),
          c.req.header("content-encoding"),
          surface,
          config,
        );
      } catch {
        return c.body(null, 400);
      }
      return forwardEnvelope(target, envelope, fetchImpl);
    },
  );

  return app;
}

async function forwardEnvelope(
  target: DsnTarget,
  envelope: Uint8Array,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    const upstream = await fetchImpl(`${target.envelopeUrl}?sentry_key=${target.publicKey}`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: new Uint8Array(envelope),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    await upstream.body?.cancel();
    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!upstream.ok) {
      getLogger().warn("client error report forwarding rejected", {
        "http.status": upstream.status,
      });
      markExpectedFailure();
    }
    return new Response(null, { status: upstream.status, headers });
  } catch {
    getLogger().warn("client error report forwarding failed");
    markExpectedFailure();
    return new Response(null, { status: 502 });
  }
}

function addressedTo(envelope: Uint8Array, target: DsnTarget): boolean {
  const newline = envelope.indexOf(10);
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder().decode(newline === -1 ? envelope : envelope.subarray(0, newline)),
    );
  } catch {
    return false;
  }
  const dsn = (header as { dsn?: unknown } | null)?.dsn;
  const parsed = typeof dsn === "string" ? parseDsn(dsn) : undefined;
  return parsed?.envelopeUrl === target.envelopeUrl && parsed.publicKey === target.publicKey;
}
