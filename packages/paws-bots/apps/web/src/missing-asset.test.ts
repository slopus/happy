import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { missingAssetMiddleware } from "./missing-asset";

const assetsDir = path.resolve("/srv/dist/assets");
const archiveDir = path.resolve("/srv/archive/assets");
const present = new Set([path.join(assetsDir, "index-new.js")]);

function request(url: string, archive: string | null = null) {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  missingAssetMiddleware(assetsDir, "/assets/", archive, (file) => present.has(file))(
    { url, method: "HEAD" } as IncomingMessage,
    res as unknown as ServerResponse,
    next,
  );
  return { res, next };
}

describe("missing asset middleware", () => {
  it("answers 404 for a chunk from an older build instead of falling back to index.html", () => {
    const { res, next } = request("/assets/index-old.js");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("serves assets that exist and leaves app routes to the SPA fallback", () => {
    expect(request("/assets/index-new.js?v=1").next).toHaveBeenCalled();
    expect(request("/app/settings").next).toHaveBeenCalled();
  });

  it("serves a chunk an earlier build left in the archive", () => {
    present.add(path.join(archiveDir, "index-old.js"));
    const { res, next } = request("/assets/index-old.js", archiveDir);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/javascript");
    expect(res.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "public, max-age=31536000, immutable",
    );
    expect(request("/assets/gone.js", archiveDir).res.statusCode).toBe(404);
    const outside = path.resolve(archiveDir, "../builds/1.json");
    present.add(outside);
    expect(request("/assets/..%2Fbuilds%2F1.json", archiveDir).res.statusCode).toBe(404);
    present.delete(outside);
    present.delete(path.join(archiveDir, "index-old.js"));
  });

  it("does not resolve outside the assets directory", () => {
    expect(request("/assets/..%2Fassets%2Findex-new.js").next).toHaveBeenCalled();
    expect(request("/assets/..%2F..%2Fetc%2Fpasswd").res.statusCode).toBe(404);
    expect(request("/assets/%E0%A4%A").res.statusCode).toBe(404);
  });
});
