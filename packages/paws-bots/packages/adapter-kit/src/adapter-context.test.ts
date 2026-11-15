import { describe, expect, it } from "vitest";
import { createAdapterContext } from "./adapter-context.js";

describe("createAdapterContext", () => {
  it("preserves ownership and correlates the operation and trace", () => {
    const context = createAdapterContext(
      { spaceId: "space-1", userId: "user-1" },
      "bot-1",
      "artifact-create:bot-1",
    );
    expect(context).toEqual({
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      operationId: "artifact-create:bot-1",
      traceId: "artifact-create:bot-1",
      signal: expect.any(AbortSignal),
    });
  });

  it("creates a fresh, non-aborted signal for each operation", () => {
    const actor = { spaceId: "space-1", userId: "user-1" };
    const first = createAdapterContext(actor, "bot-1", "files");
    const second = createAdapterContext(actor, "bot-1", "files");
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(first.signal).not.toBe(second.signal);
  });
});
