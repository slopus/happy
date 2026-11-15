import type { ComputerUpdate } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComputerUpdates } from "./computer-updates.js";

const update: ComputerUpdate = {
  id: "update-1",
  botId: "bot-1",
  name: "Writer",
  mode: "team",
  action: "update",
  status: "running",
  stage: "saving",
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("computer update presentation", () => {
  it("keeps a newly started update when an older poll returns, and closing does not stop polling", async () => {
    vi.useFakeTimers();
    let resolve!: (rows: ComputerUpdate[]) => void;
    const list = vi.fn(
      () =>
        new Promise<ComputerUpdate[]>((done) => {
          resolve = done;
        }),
    );
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
    });
    const stop = store.watch();
    await store.start("bot-1");
    resolve([]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({ updates: [update], openId: update.id });
    store.open(null);
    await vi.advanceTimersByTimeAsync(1500);
    resolve([{ ...update, stage: "restoring" }]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual({
      updates: [{ ...update, stage: "restoring" }],
      openId: null,
    });
    stop();
  });
  it("restores background progress on a new mount and ignores responses after disposal", async () => {
    vi.useFakeTimers();
    const store = createComputerUpdates({
      list: async () => [update],
      start: async () => update,
      dismiss: async () => {},
    });
    let stop = store.watch();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([update]);
    stop();
    stop = store.watch();
    stop();
    await Promise.resolve();
    expect(store.getSnapshot().updates).toEqual([]);
  });
  it("polls quickly only while an update is in progress", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => [{ ...update, status: "failed" }]);
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
    });
    const stop = store.watch();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue([update]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("stops polling on a 401 and resumes on the next watch", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    });
    const store = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
    });
    let stop = store.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
    list.mockResolvedValue([]);
    stop = store.watch();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
  it("stops polling when the server refuses this build", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Update required"), { status: 426 });
    });
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
    }).watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(1);
    stop();
  });
  it("keeps polling through other failures", async () => {
    vi.useFakeTimers();
    // Failure retries wait between half and all of the backoff; pin the full wait.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const list = vi.fn(async (): Promise<ComputerUpdate[]> => {
      throw Object.assign(new Error("Unavailable"), { status: 503 });
    });
    const stop = createComputerUpdates({
      list,
      start: async () => update,
      dismiss: async () => {},
    }).watch();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(list).toHaveBeenCalledTimes(3);
    stop();
  });
});
