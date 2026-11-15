import { afterEach, describe, expect, it, vi } from "vitest";
import type { HindsightConnectionConfig } from "./hindsight-client.js";
import {
  deleteHindsightDocument,
  HINDSIGHT_CLOUD_BASE_URL,
  hindsightBankExists,
  hindsightOperationStatus,
  listHindsightDocumentIdsByTag,
  probeHindsightKey,
  recallHindsight,
  retainHindsight,
} from "./hindsight-client.js";

const config: HindsightConnectionConfig = {
  baseUrl: HINDSIGHT_CLOUD_BASE_URL,
  apiKey: "hsk-test-key",
};
afterEach(() => vi.restoreAllMocks());

describe("Hindsight client", () => {
  it("sends the key only when there is one", async () => {
    const fetch = vi.fn(async () => Response.json({ banks: [] }));
    await probeHindsightKey({ ...config, fetch });
    await probeHindsightKey({ ...config, apiKey: "", fetch });
    const headers = fetch.mock.calls.map(
      (call) => new Headers((call as unknown as [string, RequestInit])[1].headers),
    );
    expect(headers[0]?.get("authorization")).toBe("Bearer hsk-test-key");
    expect(headers[1]?.has("authorization")).toBe(false);
  });

  it("reports a refused request without echoing the body and cancels it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("bad key hsk-test-key"));
      },
      cancel,
    });
    const fetch = vi.fn(async () => new Response(body, { status: 403 }));
    expect(await probeHindsightKey({ ...config, fetch })).toEqual({
      ok: false,
      error: "Hindsight request failed: 403",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("reports an unreachable server", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED hsk-test-key");
    });
    expect(await hindsightBankExists({ ...config, fetch }, "other-app")).toEqual({
      ok: false,
      error: "Hindsight is unreachable or the request timed out.",
    });
  });

  it("gives setup and recall short interactive deadlines", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    await hindsightBankExists({ ...config, fetch }, "other-app");
    await recallHindsight({ ...config, fetch }, "other-app", { query: "tea" });
    expect(timeout.mock.calls).toEqual([[10_000], [15_000]]);
  });

  it("uses short deadlines for document cleanup instead of the reflection timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    await deleteHindsightDocument({ ...config, fetch }, "bank", "document");
    await listHindsightDocumentIdsByTag({ ...config, fetch }, "bank", "session:thread");
    expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
  });
  it("uses a short deadline for operation metadata", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => Response.json({ status: "pending" }));
    await hindsightOperationStatus({ ...config, fetch }, "bank", "operation");
    expect(timeout.mock.calls).toEqual([[10_000]]);
  });

  it("bounds writes independently of the long reflection timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async () => Response.json({ success: true }));
    await retainHindsight({ ...config, fetch }, "bank", { items: [], async: false });
    expect(timeout.mock.calls).toEqual([[30_000]]);
  });

  it("reads a bank nothing was retained to as empty", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(await recallHindsight({ ...config, fetch }, "other-app", { query: "tea" })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("lists the documents carrying a tag", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) =>
      Response.json({ items: [{ id: "a" }, { id: "b" }] }),
    );
    expect(
      await listHindsightDocumentIdsByTag({ ...config, fetch }, "other-app", "session:x"),
    ).toEqual({ ok: true, value: ["a", "b"] });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${HINDSIGHT_CLOUD_BASE_URL}/v1/default/banks/other-app/documents?tags=session%3Ax&tags_match=all_strict&limit=100`,
    );
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    expect(
      await listHindsightDocumentIdsByTag({ ...config, fetch: missing }, "other-app", "session:x"),
    ).toEqual({ ok: true, value: [] });
  });
});
