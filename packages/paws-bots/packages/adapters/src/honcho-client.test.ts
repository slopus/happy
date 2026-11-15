import { afterEach, describe, expect, it, vi } from "vitest";
import type { HonchoConnectionConfig } from "./honcho-client.js";
import {
  deleteHonchoConclusion,
  ensureHonchoWorkspace,
  getHonchoConclusion,
  honchoPeerChat,
  queryHonchoConclusions,
} from "./honcho-client.js";

const config: HonchoConnectionConfig = {
  baseUrl: "https://api.honcho.dev",
  apiKey: "hch-test-key",
  reasoningLevel: "low",
};
const chat = { peerId: "bot-1", target: "user-1", query: "Relevant facts?" };
afterEach(() => vi.restoreAllMocks());

describe("Honcho client boundaries", () => {
  it.each([".", "..", "../other", "id/other", "id?query", "x".repeat(513)])(
    "rejects unsafe conclusion id %s before transport",
    async (id) => {
      const fetch = vi.fn();
      for (const operation of [getHonchoConclusion, deleteHonchoConclusion]) {
        expect(await operation({ ...config, fetch }, "team", id)).toEqual({
          ok: false,
          error: "Invalid Honcho conclusion id.",
        });
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe ids returned by a conclusion search", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        { id: "..", content: "Fact", observer_id: "bot-1", observed_id: "rakazo-shared" },
      ]),
    );
    expect(
      await queryHonchoConclusions({ ...config, fetch }, "team", {
        query: "Fact",
        observerId: "bot-1",
        observedId: "rakazo-shared",
        topK: 100,
      }),
    ).toEqual({ ok: false, error: "Honcho returned invalid conclusions." });
  });

  it("bounds every fetch with the correct timeout and passes caller cancellation", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path !== "/v3/workspaces" && path !== "/v3/workspaces/team/peers/bot-1/chat")
        throw new Error("Unexpected request");
      signals.push(init?.signal as AbortSignal);
      return new Response(JSON.stringify({ content: "A fact" }));
    });
    await ensureHonchoWorkspace({ ...config, fetch }, "team", controller.signal);
    await honchoPeerChat({ ...config, fetch }, "team", chat, controller.signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[15_000], [60_000]]);
    controller.abort();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("returns a bounded failure when the connection probe times out", async () => {
    const signal = AbortSignal.abort(new DOMException("hch-test-key", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      throw new Error("Expected aborted signal");
    });
    expect(await ensureHonchoWorkspace({ ...config, fetch }, "team")).toEqual({
      ok: false,
      error: "Honcho is unreachable or the request timed out.",
    });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it.each([null, [], { content: 42 }, { answer: "wrong field" }])(
    "rejects malformed chat response %j",
    async (body) => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
      expect(await honchoPeerChat({ ...config, fetch }, "team", chat)).toEqual({
        ok: false,
        error: "Honcho returned an invalid chat response.",
      });
    },
  );

  it("treats a null dialectic answer as empty", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: null })));
    expect(await honchoPeerChat({ ...config, fetch }, "team", chat)).toEqual({
      ok: true,
      value: "",
    });
  });

  it("truncates the dialectic query to Honcho's limit without splitting a character", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ content: "A fact" })),
    );
    await honchoPeerChat({ ...config, fetch }, "team", {
      ...chat,
      query: `a${"😀".repeat(6_000)}`,
    });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { query: string };
    expect(body.query).toBe(`a${"😀".repeat(4_999)}`);
  });

  it.each(["not JSON hch-test-key", JSON.stringify({ content: "x".repeat(1024 * 1024) })])(
    "rejects unreadable or oversized chat bodies",
    async (body) => {
      const fetch = vi.fn(async () => new Response(body));
      expect(await honchoPeerChat({ ...config, fetch }, "team", chat)).toEqual({
        ok: false,
        error: "Honcho returned an unreadable response.",
      });
    },
  );

  it("discards remote error bodies rather than reflecting credentials or unbounded detail", async () => {
    const response = new Response("hch-test-key" + "x".repeat(100_000), { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetch = vi.fn(async () => response);
    expect(await honchoPeerChat({ ...config, fetch }, "team", chat)).toEqual({
      ok: false,
      error: "Honcho request failed: 403",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
