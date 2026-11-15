import { describe, expect, it } from "vitest";
import { ProductEventSchema, ThreadActivityPayloadSchema } from "./events.js";

const event = {
  id: "event-1",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  seq: 1,
  type: "thread.meta",
  runId: "run-1",
  createdAt: "2026-10-27T00:00:00Z",
  payload: { activity: { thinking: true } },
};
describe("coarse public thinking contract", () => {
  it("accepts only an explicit boolean and required run scope", () => {
    expect(ProductEventSchema.parse(event)).toEqual(event);
    expect(ThreadActivityPayloadSchema.parse({ activity: { thinking: false } })).toEqual({
      activity: { thinking: false },
    });
    expect(ProductEventSchema.safeParse({ ...event, runId: undefined }).success).toBe(false);
    for (const payload of [
      { activity: { thinking: "true" } },
      { activity: { thinking: true }, text: "private" },
      { activity: { thinking: true, text: "private" } },
      { activity: { thinking: true, partial: { content: "private" } } },
    ]) {
      expect(ThreadActivityPayloadSchema.safeParse(payload).success).toBe(false);
      expect(ProductEventSchema.safeParse({ ...event, payload }).success).toBe(false);
    }
  });
  it("preserves existing and unrelated metadata without imposing an activity run scope", () => {
    expect(ThreadActivityPayloadSchema.safeParse({}).success).toBe(false);
    for (const payload of [
      {},
      { notice: "stuck", state: "pending" },
      { activity: { status: "unrelated" } },
    ]) {
      expect(ProductEventSchema.parse({ ...event, runId: undefined, payload }).payload).toEqual(
        payload,
      );
    }
  });
});
