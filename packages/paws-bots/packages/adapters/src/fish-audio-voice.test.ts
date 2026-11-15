import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FishAudioVoiceProvider } from "./fish-audio-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Fish Audio catalog pagination", () => {
  it("loads five delayed public pages before a client deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("synthetic client deadline");
    setTimeout(() => controller.abort(reason), 15_000);
    let activePublic = 0;
    let maxPublic = 0;
    const pages: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.searchParams.has("self")) return Response.json({ items: [] });
        const page = Number(url.searchParams.get("page_number"));
        pages.push(page);
        activePublic++;
        maxPublic = Math.max(maxPublic, activePublic);
        try {
          await delay(4_000, init?.signal);
          return Response.json({
            total: 500,
            items: [{ _id: `public-${page}`, title: `Public ${page}` }],
          });
        } finally {
          activePublic--;
        }
      }),
    );
    const started = Date.now();
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", { ...context, signal: controller.signal })
      .then(
        (voices) => ({ ids: voices.map((voice) => voice.id), elapsed: Date.now() - started }),
        (error: unknown) => ({ error }),
      );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(await outcome).toEqual({
      ids: ["public-1", "public-2", "public-3", "public-4", "public-5"],
      elapsed: 12_000,
    });
    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(maxPublic).toBe(2);
    expect(activePublic).toBe(0);
  });

  it("keeps page order and own-first deduplication when later pages finish first", async () => {
    vi.useFakeTimers();
    const completed: number[] = [];
    mockCatalog(async (page, own, signal) => {
      if (own) return { items: [{ _id: "shared", title: "Own" }] };
      await delay(page % 2 === 0 ? 100 : 10, signal);
      completed.push(page);
      return {
        total: 500,
        items: [
          { _id: `public-${page}`, title: `Page ${page}` },
          { _id: "shared", title: "Public duplicate" },
          { _id: "public-duplicate", title: `First seen on ${page}` },
        ],
      };
    });
    const voices = new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

    await vi.runAllTimersAsync();

    expect(completed).toEqual([1, 3, 2, 5, 4]);
    expect((await voices).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "shared", label: "Own" },
      { id: "public-1", label: "Page 1" },
      { id: "public-duplicate", label: "First seen on 1" },
      ...[2, 3, 4, 5].map((page) => ({ id: `public-${page}`, label: `Page ${page}` })),
    ]);
  });

  it.each([undefined, "500", -1])(
    "keeps unknown or invalid totals sequential (%s)",
    async (total) => {
      vi.useFakeTimers();
      let active = 0;
      let maxActive = 0;
      const requests = mockCatalog(async (page, own, signal) => {
        if (own) return { items: [] };
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(10, signal);
        active--;
        return { total, has_more: page < 3, items: [{ _id: `public-${page}` }] };
      });
      const voices = new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

      await vi.runAllTimersAsync();

      expect(await voices).toHaveLength(3);
      expect(requests.filter((request) => !request.own).map(({ page }) => page)).toEqual([1, 2, 3]);
      expect(maxActive).toBe(1);
    },
  );

  it("keeps owned pages sequential and both catalog walks within their page budgets", async () => {
    vi.useFakeTimers();
    const active = { own: 0, public: 0 };
    const maxActive = { own: 0, public: 0 };
    const requests = mockCatalog(async (page, own, signal) => {
      const kind = own ? "own" : "public";
      active[kind]++;
      maxActive[kind] = Math.max(maxActive[kind], active[kind]);
      await delay(10, signal);
      active[kind]--;
      return { total: 1_000_000, has_more: true, items: [{ _id: `${kind}-${page}` }] };
    });
    const voices = new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

    await vi.runAllTimersAsync();

    expect(await voices).toHaveLength(25);
    expect(maxActive).toEqual({ own: 1, public: 2 });
    expect(requests.filter(({ own }) => own).map(({ page }) => page)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(requests.filter(({ own }) => !own).map(({ page }) => page)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([false, true])(
    "does not prefetch after a terminal first page (empty=%s)",
    async (empty) => {
      const requests = mockCatalog((_page, own) => ({
        total: 500,
        has_more: false,
        items: own || empty ? [] : [{ _id: "only" }],
      }));

      expect(await new FishAudioVoiceProvider().listVoices("fake-fish-key", context)).toHaveLength(
        empty ? 0 : 1,
      );
      expect(requests).toHaveLength(2);
    },
  );

  it.each(["HTTP error", "network error", "pending body"])(
    "ignores and cancels speculative pages past an early stop (%s)",
    async (failure) => {
      const requests = mockCatalog(async (page, own, signal) => {
        if (own) return { items: [] };
        if (page === 3) {
          if (failure === "network error") throw new Error("unused page failed");
          if (failure === "HTTP error") return Response.json({ detail: "unused" }, { status: 502 });
          return new Response(
            new ReadableStream({
              start(stream) {
                signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
              },
            }),
          );
        }
        return {
          total: 500,
          has_more: page === 1,
          items: page === 1 ? [{ _id: "first" }] : [],
        };
      });

      const voices = await new FishAudioVoiceProvider().listVoices("fake-fish-key", context);

      expect(voices.map(({ id }) => id)).toEqual(["first"]);
      expect(requests.filter(({ own }) => !own).map(({ page }) => page)).toEqual([1, 2, 3]);
      expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
    },
  );

  it("preserves a required page's account error and cancels sibling requests", async () => {
    vi.useFakeTimers();
    let active = 0;
    const requests = mockCatalog(async (page, own, signal) => {
      if (!own && page === 1) return { total: 500, items: [{ _id: "first" }] };
      active++;
      try {
        await delay(!own && page === 2 ? 10 : 100_000, signal);
        return Response.json({ detail: "Invalid API key" }, { status: 401 });
      } finally {
        active--;
      }
    });
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", context)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);

    expect(await outcome).toMatchObject({ code: "VOICE_KEY_REJECTED" });
    expect(active).toBe(0);
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map(({ signal }) => signal)).size).toBe(1);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("propagates a caller abort to both catalog walks without requesting more pages", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const requests = mockCatalog(async (page, own, signal) => {
      if (!own && page === 1) return { total: 500, items: [{ _id: "first" }] };
      await delay(100_000, signal);
      return { items: [] };
    });
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", { ...context, signal: controller.signal })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(reason);

    expect(await outcome).toBe(reason);
    expect(requests).toHaveLength(4);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it("does not request any pages when already canceled", async () => {
    const controller = new AbortController();
    const reason = new Error("already canceled");
    controller.abort(reason);
    const requests = mockCatalog(() => ({ items: [] }));

    await expect(
      new FishAudioVoiceProvider().listVoices("fake-fish-key", {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(requests).toEqual([]);
  });

  it("retains the shared twenty-second listing deadline", async () => {
    vi.useFakeTimers();
    const reason = new DOMException("synthetic provider timeout", "TimeoutError");
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(20_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(reason), ms);
      return controller.signal;
    });
    const requests = mockCatalog(async (_page, _own, signal) => {
      await delay(100_000, signal);
      return { items: [] };
    });
    const outcome = new FishAudioVoiceProvider()
      .listVoices("fake-fish-key", context)
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await outcome).toBe(reason);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true);
  });
});

function mockCatalog(
  reply: (page: number, own: boolean, signal: AbortSignal) => unknown | Promise<unknown>,
) {
  const requests: Array<{ page: number; own: boolean; signal: AbortSignal }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page_number"));
      const own = url.searchParams.has("self");
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      requests.push({ page, own, signal });
      const body = await reply(page, own, signal);
      return body instanceof Response ? body : Response.json(body);
    }),
  );
  return requests;
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

describe("Fish Audio language filter", () => {
  it("advertises catalog language support", () => {
    expect(new FishAudioVoiceProvider().describe().capabilities.languages).toBe(true);
  });

  it("sends the language filter on public pages but not user-owned pages", async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        queries.push(url.searchParams.toString());
        if (url.searchParams.has("self")) return Response.json({ items: [] });
        return Response.json({
          total: 1,
          items: [{ _id: "public-1", title: "Public" }],
        });
      }),
    );
    const voices = await new FishAudioVoiceProvider().listVoices("fake-fish-key", context, {
      language: "de-DE",
    });
    expect(voices.map((voice) => voice.id)).toEqual(["public-1"]);
    const publicQueries = queries.filter((query) => !query.includes("self=true"));
    expect(publicQueries.length).toBeGreaterThan(0);
    for (const query of publicQueries) expect(query).toContain("language=de");
    for (const query of queries.filter((query) => query.includes("self=true")))
      expect(query).not.toContain("language=");
  });
});
