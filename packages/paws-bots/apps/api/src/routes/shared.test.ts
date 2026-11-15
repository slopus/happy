import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT, HEARTBEAT_MS, withHeartbeats } from "./shared.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withHeartbeats", () => {
  it("keeps the in-flight read across heartbeats so events stay in order", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reads = vi.fn();
    async function* follow() {
      reads();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield "first";
      yield "second";
    }
    const stream = withHeartbeats({}, follow);

    const heartbeat = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await expect(heartbeat).resolves.toEqual({ done: false, value: HEARTBEAT });

    const first = stream.next();
    release?.();
    await expect(first).resolves.toEqual({ done: false, value: "first" });
    await expect(stream.next()).resolves.toEqual({ done: false, value: "second" });
    expect(reads).toHaveBeenCalledOnce();
    await stream.return(undefined);
  });

  it("holds no abort listener once each event is delivered", async () => {
    const request = new AbortController();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      for (let i = 0; i < 50; i++) yield i;
    });

    for (let i = 0; i < 50; i++) await stream.next();

    expect(getEventListeners(request.signal, "abort")).toHaveLength(0);
    await stream.return(undefined);
  });

  it("does not start reading when the request has already aborted", async () => {
    const request = new AbortController();
    request.abort();
    const reads = vi.fn();
    const stream = withHeartbeats({ signal: request.signal }, async function* () {
      reads();
      yield "event";
    });

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(reads).not.toHaveBeenCalled();
  });

  it("ends on revocation without waiting for a read the abort never lands on", async () => {
    vi.useFakeTimers();
    let sourceSignal: AbortSignal | undefined;
    const stillAuthorized = vi.fn(async () => false);
    const stream = withHeartbeats({ stillAuthorized }, async function* (signal) {
      sourceSignal = signal;
      await new Promise<never>(() => {});
      yield "never";
    });

    const ended = expect(stream.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await ended;
    expect(stillAuthorized).toHaveBeenCalledOnce();
    expect(sourceSignal?.aborted).toBe(true);
  });

  it("ends when the request aborts, without re-checking the session or waiting for the source", async () => {
    vi.useFakeTimers();
    const request = new AbortController();
    const stillAuthorized = vi.fn(async () => true);
    const stream = withHeartbeats({ signal: request.signal, stillAuthorized }, async function* () {
      await new Promise<never>(() => {});
      yield "never";
    });

    const first = stream.next();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    request.abort();
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(stillAuthorized).not.toHaveBeenCalled();
  });
});
