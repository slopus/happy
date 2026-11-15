import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  WebFetchRequest,
  WebFetchResult,
  WebProvider,
  WebSearchHit,
  WebSearchRequest,
} from "@rakazo/adapter-kit";
import { resolveEncryptionKey } from "@rakazo/core";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { callRemoteMcpTool } from "./remote-mcp.js";
import { clampMaxChars, clampMaxResults, clampOffset, pageWindow } from "./web-limits.js";
import { assertSafeWebUrl, withAbort } from "./web-ssrf.js";

const ENDPOINT = "https://search.parallel.ai/mcp";
const USER_AGENT = "Rakazo/0.1 (+https://github.com/elie222/rakazo; web tools)";
const MAX_SNIPPET_CHARS = 8_000;
const pageSchema = z.object({
  url: z.string().max(8_192),
  title: z.string().nullable().optional(),
  excerpts: z.array(z.string()),
  full_content: z.string().nullable().optional(),
});
const responseSchema = z.object({
  results: z.array(pageSchema),
  errors: z.array(z.object({ error_type: z.string() })).optional(),
});

export type ParallelWebOptions = RemoteTransportDependencies & {
  searchTimeoutMs?: number;
  fetchTimeoutMs?: number;
};

/** Optional anonymous MCP backend for the existing builtin web tools. */
export class ParallelWebProvider implements WebProvider {
  private readonly sessionKey = resolveEncryptionKey();

  constructor(private readonly options: ParallelWebOptions = {}) {}

  describe() {
    return {
      id: "parallel",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, fetch: true, keyless: true, native: false, readability: true },
    };
  }

  async search(request: WebSearchRequest, context: AdapterContext): Promise<WebSearchHit[]> {
    const query = request.query.trim();
    if (!query) throw new Error("query is required");
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.searchTimeoutMs,
    );
    const response = await this.call(
      "web_search",
      { objective: query, search_queries: [query] },
      context,
      signal,
      clampMaxResults(request.maxResults),
    );
    return response.results
      .filter((page) => publicPageUrl(page.url) !== undefined)
      .slice(0, clampMaxResults(request.maxResults))
      .map((page) => ({
        url: publicPageUrl(page.url)!,
        title: page.title?.trim() || page.url,
        snippet: page.excerpts.join("\n\n"),
      }));
  }

  async fetch(request: WebFetchRequest, context: AdapterContext): Promise<WebFetchResult> {
    const maxChars = clampMaxChars(request.maxChars);
    const offset = clampOffset(request.offset);
    const signal = this.signal(
      combineSignals(request.signal, context.signal),
      this.options.fetchTimeoutMs,
    );
    // Validate before disclosing the requested URL to the remote extraction service.
    const url = await assertSafeWebUrl(request.url, this.options.resolveHostname, signal);
    const response = await this.call(
      "web_fetch",
      { urls: [url.href], full_content: true },
      context,
      signal,
      1,
      maxChars,
      offset,
    );
    const page = response.results[0];
    if (!page)
      throw new Error(
        `Parallel page fetch failed: ${response.errors?.[0]?.error_type ?? "no content"}`,
      );
    const pageUrl = publicPageUrl(page.url);
    if (!pageUrl) throw new Error("Parallel returned an invalid page URL");
    const text = page.full_content ?? page.excerpts.join("\n\n");
    return {
      url: pageUrl,
      title: page.title?.trim() || pageUrl,
      ...pageWindow(text, maxChars, offset),
    };
  }

  private signal(parent: AbortSignal, timeoutMs = 30_000) {
    parent.throwIfAborted();
    return combineSignals(parent, AbortSignal.timeout(timeoutMs));
  }

  /** Parse and project complete MCP results while the guarded transport owns them. */
  private async call(
    name: string,
    args: Record<string, unknown>,
    context: AdapterContext,
    signal: AbortSignal,
    maxResults: number,
    maxChars?: number,
    offset = 0,
  ) {
    signal.throwIfAborted();
    // Scope conversation accounting to this deployment without disclosing raw IDs.
    const sessionId = createHmac("sha256", this.sessionKey)
      .update("rakazo:parallel:web-session:v1\0")
      .update(
        JSON.stringify([
          context.spaceId,
          context.userId,
          context.botId ?? context.runId ?? context.operationId,
        ]),
      )
      .digest("hex");
    const raw = await withAbort(
      callRemoteMcpTool(
        { ...this.options, endpoint: ENDPOINT, headers: { "User-Agent": USER_AGENT }, signal },
        name,
        { ...args, session_id: sessionId },
        (raw) => {
          const response = parseParallelResponse(raw);
          const page = response.results[0];
          if (
            maxChars !== undefined &&
            page &&
            !(page.full_content != null
              ? /\S/.test(page.full_content)
              : page.excerpts.some((part) => /\S/.test(part)))
          )
            throw new Error("Parallel returned empty page content");
          return {
            results: response.results
              .filter((page) => maxChars !== undefined || publicPageUrl(page.url) !== undefined)
              .slice(0, maxResults)
              .map((page) => ({
                url: page.url,
                title: page.title?.slice(0, 1_000),
                excerpts: [
                  joinPrefix(
                    page.excerpts,
                    maxChars === undefined ? MAX_SNIPPET_CHARS : offset + maxChars + 1,
                  ).slice(offset),
                ],
                // Drop the skipped prefix before the result size limit, and keep one extra
                // character to preserve the fetch truncation flag.
                full_content:
                  maxChars === undefined
                    ? undefined
                    : page.full_content?.slice(offset, offset + maxChars + 1),
              })),
            errors: response.errors
              ?.slice(0, 1)
              .map((error) => ({ error_type: error.error_type.slice(0, 1_000) })),
          };
        },
      ),
      signal,
    );
    const response = responseSchema.safeParse(raw);
    // A limited serialized envelope is never page text or a valid response.
    if (!response.success) throw new Error("Invalid Parallel MCP response");
    return response.data;
  }
}

/** Validate complete structured data or JSON text, never a serialized prefix. */
function parseParallelResponse(raw: unknown) {
  const envelope = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .safeParse(raw);
  if (!envelope.success) throw new Error("Invalid Parallel MCP response");
  const texts =
    envelope.data.content?.filter((item) => item.type === "text").map((item) => item.text ?? "") ??
    [];
  if (envelope.data.isError)
    throw new Error(`Parallel: ${joinPrefix(texts, 1000, "\n") || "tool request failed"}`);
  let data = envelope.data.structuredContent;
  if (data === undefined) {
    try {
      data = JSON.parse(texts.join("\n"));
    } catch {
      throw new Error("Invalid Parallel MCP response");
    }
  }
  const response = responseSchema.safeParse(data);
  if (!response.success) throw new Error("Invalid Parallel MCP response");
  return response.data;
}

/** Join only the requested prefix instead of allocating an unbounded excerpt string. */
function joinPrefix(parts: string[], maxChars: number, separator = "\n\n"): string {
  let text = "";
  for (const [index, part] of parts.entries()) {
    if (text.length >= maxChars) break;
    if (index > 0) text += separator.slice(0, maxChars - text.length);
    text += part.slice(0, maxChars - text.length);
  }
  return text;
}

/** Keep citations public HTTP(S) URLs without embedded credentials. */
function publicPageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password)
      return url.href;
  } catch {
    /* Malformed provider URLs are not usable citations. */
  }
  return undefined;
}
