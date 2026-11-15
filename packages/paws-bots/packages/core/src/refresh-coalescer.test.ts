import { describe, expect, it, vi } from "vitest";
import { createRefreshCoalescer } from "./refresh-coalescer.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("event refresh coalescing", () => {
  it("retains updates during both the first and trailing reads", async () => {
    const reads = [deferred(), deferred(), deferred()];
    const refresh = vi.fn(() => reads[refresh.mock.calls.length - 1]!.promise);
    const queue = createRefreshCoalescer(refresh);
    const first = queue.invalidate();
    await Promise.resolve();
    for (let i = 0; i < 100; i++) expect(queue.invalidate()).toBe(first);
    expect(refresh).toHaveBeenCalledTimes(1);
    reads[0]!.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    queue.invalidate();
    reads[1]!.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(3);
    reads[2]!.resolve();
    await first;
  });

  it("retries a failed read when a later invalidation is already queued", async () => {
    const read = deferred();
    const refresh = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(undefined);
    const queue = createRefreshCoalescer(refresh);
    const first = queue.invalidate();
    await Promise.resolve();
    queue.invalidate();
    read.reject(new Error("offline"));
    await first;
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reports failure and accepts a later retry", async () => {
    const queue = createRefreshCoalescer(
      vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined),
    );
    await expect(queue.invalidate()).rejects.toThrow("offline");
    await queue.invalidate();
  });

  it("discards queued reads when disposed without cancelling the active read", async () => {
    const read = deferred();
    const refresh = vi.fn(() => read.promise);
    const queue = createRefreshCoalescer(refresh);
    const first = queue.invalidate();
    await Promise.resolve();
    queue.invalidate();
    queue.dispose();
    read.resolve();
    await first;
    await queue.invalidate();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("accepts invalidation at completion and keeps subscriptions independent", async () => {
    const refresh = vi.fn(async () => {});
    const first = createRefreshCoalescer(refresh);
    const second = createRefreshCoalescer(refresh);
    await first.invalidate().then(() => first.invalidate());
    await second.invalidate();
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
