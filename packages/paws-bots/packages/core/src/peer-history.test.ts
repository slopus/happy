import type { ThreadMessage } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPeerHistory } from "./peer-history.js";

function message(id: string, seq: number): ThreadMessage {
  return { id, seq } as ThreadMessage;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("peer history loading", () => {
  it("works without AbortSignal static helpers and releases timers/listeners", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    const lifecycle = new AbortController();
    const remove = vi.spyOn(lifecycle.signal, "removeEventListener");
    await expect(
      loadPeerHistory({
        signal: lifecycle.signal,
        loadPage: async () => ({ messages: [], olderCursor: null }),
      }),
    ).resolves.toEqual([]);
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a request for an already closed view", async () => {
    const lifecycle = new AbortController();
    lifecycle.abort();
    const loadPage = vi.fn();
    await expect(loadPeerHistory({ signal: lifecycle.signal, loadPage })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("collects paginated messages in chronological page order", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message("new", 2)], olderCursor: 2 })
      .mockResolvedValueOnce({ messages: [message("old", 1)], olderCursor: null });

    const messages = await loadPeerHistory<ThreadMessage>({
      signal: new AbortController().signal,
      loadPage,
    });

    expect(messages.map(({ id }) => id)).toEqual(["old", "new"]);
    expect(loadPage.mock.calls.map(([before]) => before)).toEqual([undefined, 2]);
  });

  it("aborts a page that never settles before the full-history deadline", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory<ThreadMessage>({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    });
    const rejected = expect(loading).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("bounds the full-history scan independently of the per-page timeout", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory<ThreadMessage>({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 1_000,
      totalTimeoutMs: 100,
    });
    const rejected = expect(loading).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("aborts an in-flight page when the viewer closes", async () => {
    const lifecycle = new AbortController();
    const loadPage = vi.fn(
      (_before: number | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory<ThreadMessage>({ signal: lifecycle.signal, loadPage });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    lifecycle.abort();

    await rejected;
  });

  it("times out a loader that ignores its signal and disposes both deadlines", async () => {
    vi.useFakeTimers();
    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage: () => new Promise<never>(() => undefined),
      pageTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    });
    const rejected = expect(loading).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces the caller's reason even when the loader ignores cancellation", async () => {
    vi.useFakeTimers();
    const lifecycle = new AbortController();
    const reason = new Error("Viewer closed");
    const loading = loadPeerHistory({
      signal: lifecycle.signal,
      loadPage: () => new Promise<never>(() => undefined),
    });
    const rejected = expect(loading).rejects.toBe(reason);
    lifecycle.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
