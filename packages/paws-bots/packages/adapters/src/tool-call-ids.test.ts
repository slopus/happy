import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { runToolCallIds, withUniqueToolCallIds } from "./tool-call-ids.js";

const reply = (ids: string[]) =>
  ({
    role: "assistant",
    content: [
      { type: "text", text: "Checking." },
      ...ids.map((id) => ({ type: "toolCall", id, name: "search", arguments: {} })),
    ],
  }) as unknown as AssistantMessage;

const ids = (message: AssistantMessage) =>
  message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []));

describe("tool call ids", () => {
  it("keeps unique ids and renames repeated or empty ones within the run", () => {
    const run = runToolCallIds([reply(["call_0"])]);
    const fresh = reply(["call_a", "call_b"]);
    expect(withUniqueToolCallIds(fresh, run)).toBe(fresh);
    const renamed = withUniqueToolCallIds(reply(["call_0", "call_0", "", ""]), run);
    expect(ids(renamed)).toEqual(["call_0_1", "call_0_2", "call_1", "call_2"]);
    expect(ids(withUniqueToolCallIds(reply(["call_0"]), run))).toEqual(["call_0_3"]);
    // The provider's id stays the execution identity, also after a restored transcript.
    expect(runToolCallIds([renamed]).provider).toEqual(
      new Map([
        ["call_0_1", "call_0"],
        ["call_0_2", "call_0"],
      ]),
    );
  });
});
