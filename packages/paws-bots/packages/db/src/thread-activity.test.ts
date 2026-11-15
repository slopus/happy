import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import type { AppendEventInput } from "./events.js";
import { appendEventInTransaction, transientRunEventsWhere } from "./events.js";
import { RunHistoryWriteError } from "./messages.js";

const input: AppendEventInput = {
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  runId: "run-1",
  type: "thread.meta",
  payload: { activity: { thinking: true } },
  lease: { owner: "worker-1", fence: 2 },
};
function fixture(status = "running", leaseOwner = "worker-1", leaseFence = 2) {
  const row = { status, leaseOwner, leaseFence };
  const tx = {
    thread: { update: vi.fn(async () => ({ nextEventSeq: 2 })) },
    $queryRaw: vi.fn(async () => []),
    run: { findUnique: vi.fn(async () => row) },
    event: { create: vi.fn(async ({ data }) => data) },
  };
  return {
    tx,
    append: (event = input) =>
      appendEventInTransaction(tx as unknown as Prisma.TransactionClient, event),
  };
}
describe("transient thread activity writes", () => {
  it("persists only the boolean and normal public scope, never internal lease metadata", async () => {
    const f = fixture();
    await f.append();
    expect(f.tx.event.create).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        runId: "run-1",
        type: "thread.meta",
        seq: 1,
        payload: { activity: { thinking: true } },
      },
    });
  });
  it.each([
    ["running", "worker-new", 3],
    ["waiting_input", "worker-1", 2],
    ["completed", "worker-1", 2],
    ["cancelled", "worker-1", 2],
  ])("rejects an ended or superseded attempt (%s/%s/%s)", async (status, owner, fence) => {
    const f = fixture(String(status), String(owner), Number(fence));
    await expect(f.append()).rejects.toThrow(RunHistoryWriteError);
    await expect(
      f.append({ ...input, payload: { activity: { thinking: false } } }),
    ).rejects.toThrow(RunHistoryWriteError);
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });
  it("rejects any added reasoning data or absent attempt scope before writing", async () => {
    const f = fixture();
    await expect(
      f.append({
        ...input,
        payload: { activity: { thinking: true, text: "private fixture reasoning" } },
      }),
    ).rejects.toThrow();
    await expect(f.append({ ...input, lease: undefined })).rejects.toThrow(RunHistoryWriteError);
    await expect(f.append({ ...input, runId: undefined })).rejects.toThrow(RunHistoryWriteError);
    expect(f.tx.event.create).not.toHaveBeenCalled();
  });
});

it("limits transient cleanup to progress and exact owned thinking metadata", () => {
  const filter = transientRunEventsWhere();
  expect(filter).toEqual({
    OR: [
      { type: "thread.progress" },
      { type: "thread.meta", payload: { equals: { activity: { thinking: true } } } },
      { type: "thread.meta", payload: { equals: { activity: { thinking: false } } } },
    ],
  });
});
it("retains normal metadata semantics without an activity fence", async () => {
  const f = fixture();
  const notice = {
    ...input,
    lease: undefined,
    payload: { notice: "stuck", state: "pending" },
  };
  await f.append(notice);
  expect(f.tx.event.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ type: "thread.meta", payload: notice.payload }),
  });
});
