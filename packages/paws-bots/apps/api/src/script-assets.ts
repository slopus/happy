import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import { buildPageRuntime } from "@rakazo/page-kit/runtime-build";
import type { Hono } from "hono";

/**
 * The mobile app draws a chat diagram in a WebView that loads Mermaid from the server it already
 * talks to, so the app ships without a copy and no third-party CDN sees the request.
 */
export const DIAGRAM_SCRIPT_PATH = "/api/v1/assets/mermaid.js";

const require = createRequire(import.meta.url);

type Script = { body: Uint8Array<ArrayBuffer>; etag: string; cacheControl: string };

function cachedScript(load: () => Promise<Script>): () => Promise<Script> {
  let script: Promise<Script> | undefined;
  return () => {
    script ??= load().catch((error: unknown) => {
      script = undefined;
      throw error;
    });
    return script;
  };
}

const loadDiagramScript = cachedScript(async () => {
  const { version } = require("mermaid/package.json") as { version: string };
  const file = await readFile(require.resolve("mermaid/dist/mermaid.min.js"));
  return {
    body: new Uint8Array(file),
    etag: `"mermaid-${version}"`,
    cacheControl: "public, max-age=86400",
  };
});

// Built once per process. Revalidated on every use, so a page never renders with a kit older
// than the server that checked it.
const loadPageRuntime = cachedScript(async () => {
  const body = new TextEncoder().encode(await buildPageRuntime());
  const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
  return { body, etag: `"page-runtime-${hash}"`, cacheControl: "public, no-cache" };
});

/** Public scripts that are the same for every caller: Mermaid and the page runtime. */
export function mountScriptAssets(app: Hono) {
  for (const [path, load] of [
    [DIAGRAM_SCRIPT_PATH, loadDiagramScript],
    [PAGE_RUNTIME_PATH, loadPageRuntime],
  ] as const) {
    app.get(path, async (c) => {
      const { body, etag, cacheControl } = await load();
      const headers = { "cache-control": cacheControl, etag, "x-content-type-options": "nosniff" };
      const ifNoneMatch = c.req.header("if-none-match") ?? "";
      // Match quoted tags as a whole: commas inside an opaque tag are not list separators.
      const tags = [...ifNoneMatch.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g)];
      if (ifNoneMatch.trim() === "*" || tags.some(([, tag]) => tag === etag)) {
        return c.body(null, 304, headers);
      }
      return c.body(body, 200, { ...headers, "content-type": "text/javascript; charset=utf-8" });
    });
  }
}
