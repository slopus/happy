import { PAGE_RUNTIME_PATH } from "@rakazo/core";
import { buildPageRuntime } from "@rakazo/page-kit/runtime-build";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DIAGRAM_SCRIPT_PATH, mountScriptAssets } from "./script-assets.js";

vi.mock(import("@rakazo/page-kit/runtime-build"), async (actual) => ({
  buildPageRuntime: vi.fn((await actual()).buildPageRuntime),
}));

const app = new Hono();
mountScriptAssets(app);

describe("script asset routes", () => {
  // First, while nothing is cached: a failed build must not stay cached.
  it("builds the page runtime again after a failed build", async () => {
    vi.mocked(buildPageRuntime).mockRejectedValueOnce(new Error("esbuild crashed"));
    expect((await app.request(PAGE_RUNTIME_PATH)).status).toBe(500);
    expect((await app.request(PAGE_RUNTIME_PATH)).status).toBe(200);
    expect((await app.request(PAGE_RUNTIME_PATH)).status).toBe(200);
    expect(buildPageRuntime).toHaveBeenCalledTimes(2);
  });

  it.each([
    // The IIFE build defines a global the WebView document reads.
    [
      DIAGRAM_SCRIPT_PATH,
      "public, max-age=86400",
      /^"mermaid-\d+\.\d+\.\d+"$/,
      'globalThis["mermaid"]',
    ],
    [PAGE_RUNTIME_PATH, "public, no-cache", /^"page-runtime-[\w-]{22}"$/, "RakazoPage"],
  ])("serves %s as a cacheable public script", async (path, cacheControl, etag, global) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe(cacheControl);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toMatch(etag);
    const body = await response.text();
    expect(body).toContain(global);
  });

  it("builds a page runtime that can be inlined in a script element", async () => {
    const body = await (await app.request(PAGE_RUNTIME_PATH)).text();
    // The viewer inlines this text, so it must not end its own script element early.
    expect(body).not.toMatch(/<\/script/i);
    expect(body).not.toContain("<!--");
  });

  it("answers a revalidation without the body only when a tag matches", async () => {
    const etag = (await app.request(PAGE_RUNTIME_PATH)).headers.get("etag") ?? "";
    const revalidate = (validator: string) =>
      app.request(PAGE_RUNTIME_PATH, { headers: { "if-none-match": validator } });
    for (const validator of [etag, `W/${etag}`, `"other,tag", W/${etag}, "another"`, " * "]) {
      const response = await revalidate(validator);
      expect(response.status, validator).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    for (const validator of ['"other,tag"', 'W/"other"', '"other", "another"']) {
      const response = await revalidate(validator);
      expect(response.status, validator).toBe(200);
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  });
});
