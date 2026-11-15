import { afterEach, describe, expect, it, vi } from "vitest";
import { withEndpointOriginFallback } from "./mcp-transport.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP endpoint-origin fallback deadlines", () => {
  it("bounds discovery even with a caller signal and gives fallback the original signal", async () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const inner = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      if (inner.mock.calls.length === 1) {
        deadline.abort(new DOMException("Discovery timed out", "TimeoutError"));
        init?.signal?.throwIfAborted();
        throw new Error("Discovery was not bounded");
      }
      expect(init?.signal).toBe(caller.signal);
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ ok: true });
    });
    const fetch = withEndpointOriginFallback("https://endpoint.example.test", inner);

    const response = await fetch("https://discovery.example.test/oauth", { signal: caller.signal });

    expect(response.ok).toBe(true);
    expect(timeout).toHaveBeenCalledWith(4_000);
    expect(inner.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(String(inner.mock.calls[1]?.[0])).toBe("https://endpoint.example.test/oauth");
  });

  it("does not retry discovery when the caller cancels", async () => {
    const caller = new AbortController();
    const reason = new Error("Cancelled by caller");
    const inner = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      caller.abort(reason);
      init?.signal?.throwIfAborted();
      return Response.json({ ok: true });
    });
    const fetch = withEndpointOriginFallback("https://endpoint.example.test", inner);

    await expect(
      fetch("https://discovery.example.test/oauth", { signal: caller.signal }),
    ).rejects.toBe(reason);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
