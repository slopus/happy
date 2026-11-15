import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { notifyRealtime, observeThreadChanges } from "./event-stream.js";

describe("observeThreadChanges", () => {
  it("reports each published thread change after it reaches the fanout", async () => {
    const published: string[] = [];
    const realtime = {
      describe: vi.fn(),
      publish: vi.fn(async (topic: string) => {
        published.push(topic);
      }),
      subscribe: vi.fn(),
      close: vi.fn(),
    } as unknown as RealtimeFanout;
    const changed = vi.fn((threadId: string) => {
      expect(published).toContain(`thread:${threadId}`);
    });
    const observed = observeThreadChanges(realtime, changed);
    await notifyRealtime(observed, "thread-1", 4);
    await observed.publish("incoming-calls:user-1", "");
    expect(changed.mock.calls).toEqual([["thread-1"]]);
    expect(published).toEqual(["thread:thread-1", "incoming-calls:user-1"]);
  });

  it("still reports a committed change whose publish failed", async () => {
    const realtime = {
      publish: vi.fn().mockRejectedValue(new Error("fanout down")),
    } as unknown as RealtimeFanout;
    const changed = vi.fn();
    await notifyRealtime(observeThreadChanges(realtime, changed), "thread-1", 5);
    expect(changed).toHaveBeenCalledWith("thread-1");
  });
});
