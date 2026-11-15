import { describe, expect, it } from "vitest";
import { threadSendInput } from "./rpc.js";

describe("threads.send input bounds", () => {
  it("accepts chat text within the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_000) });
    expect(parsed.success).toBe(true);
  });

  it("rejects chat text past the length bound", () => {
    const parsed = threadSendInput.safeParse({ botId: "bot-1", text: "a".repeat(100_001) });
    expect(parsed.success).toBe(false);
  });
});
