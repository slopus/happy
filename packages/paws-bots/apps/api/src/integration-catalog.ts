import type { IntegrationCatalogResult, IntegrationCatalogSurface } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";

const RESPONSE_LIMIT = 1_000_000;
const SEARCH_LIMIT = 8;
const SURFACE_LIMIT = 24;

export async function searchIntegrationCatalog(input: {
  baseUrl: string;
  query: string;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
}): Promise<IntegrationCatalogResult[]> {
  const query = input.query.trim();
  if (!query) return [];

  const baseUrl = new URL(input.baseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("Integration catalog URL must use HTTP or HTTPS");
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const searchUrl = new URL("api/search", baseUrl);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("limit", String(SEARCH_LIMIT));

  // Admin-configured bases may be private (LAN mirrors). Do not reuse connector
  // SSRF checks that block private hosts. Still refuse redirects so a mirror
  // cannot bounce the server onto cloud metadata or another host.
  const response = await (input.fetch ?? globalThis.fetch)(searchUrl, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(5_000)]),
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    cancelResponseBody(response);
    throw new Error("Integration catalog redirects are not allowed");
  }
  if (!response.ok) throw new Error(`Integration catalog returned HTTP ${response.status}`);
  const body = await readBoundedResponse(response);

  const payload: unknown = JSON.parse(body);
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new Error("Integration catalog returned an invalid response");
  }
  return payload.results.slice(0, SEARCH_LIMIT).flatMap(normalizeResult);
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT) {
    throw new Error("Integration catalog response is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Integration catalog response is too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function normalizeResult(value: unknown): IntegrationCatalogResult[] {
  if (!isRecord(value)) return [];
  const domain = shortString(value.domain, 253);
  if (!domain) return [];
  const surfaces = Array.isArray(value.surfaces)
    ? value.surfaces.slice(0, SURFACE_LIMIT).flatMap(normalizeSurface)
    : [];
  return [
    {
      domain,
      name: shortString(value.name, 120) ?? domain,
      description: shortString(value.description, 500) ?? "",
      pageUrl: httpUrl(value.url),
      surfaces,
    },
  ];
}

function normalizeSurface(value: unknown): IntegrationCatalogSurface[] {
  if (!isRecord(value)) return [];
  const kind = value.kind;
  if (kind !== "mcp" && kind !== "openapi" && kind !== "graphql" && kind !== "cli") return [];
  const slug = shortString(value.slug, 120);
  if (!slug) return [];
  return [
    {
      kind,
      slug,
      source: httpUrl(value.url),
      auth: normalizeAuth(value.auth),
    },
  ];
}

function normalizeAuth(value: unknown): IntegrationCatalogSurface["auth"] {
  if (!isRecord(value)) return null;
  const kind = shortString(value.kind, 40)?.toLowerCase();
  const note = shortString(value.note, 500) ?? null;
  if (kind === "none") return { type: "none", headerName: null, note };

  const header = shortString(value.header, 200);
  const headerName = header?.split(":", 1)[0]?.trim() || null;
  if (headerName?.toLowerCase() === "authorization" && /:\s*bearer\b/i.test(header ?? "")) {
    return { type: "bearer", headerName: null, note };
  }
  if (headerName) return { type: "header", headerName, note };
  if (kind && ["bearer", "token", "mixed", "oauth", "oauth2"].includes(kind)) {
    return { type: "bearer", headerName: null, note };
  }
  return note ? { type: "bearer", headerName: null, note } : null;
}

function shortString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result.slice(0, limit) : null;
}

function httpUrl(value: unknown): string | null {
  const candidate = shortString(value, 2_048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
