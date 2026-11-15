import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  releasedTakeoverComputerBlocks,
  TAKEOVER_COMPUTER_DONE_STATE,
  TAKEOVER_COMPUTER_PENDING_STATE,
  TAKEOVER_COMPUTER_SKIPPED_STATE,
  takeLiveMessage,
  takeoverComputerSettledState,
  updateCloudAgentMessages,
} from "./thread-message-updates.js";

const cloud = (agentId: string): MessageBlock => ({
  kind: "cloud_agent",
  agentId,
  title: "Agent",
  status: "running",
  url: "",
});

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("updates every matching cloud block while preserving metadata and unrelated messages", () => {
    const messages = [
      { id: "first", replyToMessageId: "reply", blocks: [cloud("agent"), cloud("other")] },
      { id: "second", replyToMessageId: "reply", blocks: [cloud("agent")] },
      {
        id: "third",
        replyToMessageId: "reply",
        blocks: [{ kind: "text", text: "unchanged" } as MessageBlock],
      },
    ];
    const result = updateCloudAgentMessages(messages, {
      messageId: "first",
      agentId: "agent",
      status: "finished",
    });
    expect(result.map((message) => message.id)).toEqual(["first", "second", "third"]);
    expect(result[0]?.replyToMessageId).toBe("reply");
    expect(result[0]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[1]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]?.blocks[0]).toMatchObject({ status: "running" });
  });

  it("settles only a pending takeover computer card", () => {
    const text = { kind: "text" as const, text: "keep" };
    const ask = { kind: "ask" as const, text: "Which one?", status: "pending" as const };
    const settled = { kind: "computer" as const, state: "Ready", text: "leave" };
    const pending = releasedTakeoverComputerBlocks(
      [
        text,
        ask,
        settled,
        { kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Sign in if you want." },
      ],
      "done",
    );
    expect(pending).toEqual([
      text,
      ask,
      settled,
      {
        kind: "computer",
        state: TAKEOVER_COMPUTER_DONE_STATE,
        text: "Sign in if you want.",
      },
    ]);
    expect(pending?.[0]).toBe(text);
    expect(pending?.[2]).toBe(settled);
    expect(
      releasedTakeoverComputerBlocks(
        [
          { kind: "computer", state: TAKEOVER_COMPUTER_DONE_STATE, text: "done" },
          { kind: "computer", state: TAKEOVER_COMPUTER_SKIPPED_STATE, text: "skipped" },
          { kind: "text", text: "keep" },
        ],
        "released",
      ),
    ).toBeNull();
    expect(
      releasedTakeoverComputerBlocks(
        [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Still there." }],
        "skipped",
      ),
    ).toEqual([{ kind: "computer", state: TAKEOVER_COMPUTER_SKIPPED_STATE, text: "Still there." }]);
  });

  it("names Done and Skipped from the release reason and checkpoint", () => {
    for (const reason of ["done", "released", "takeover", undefined]) {
      expect(takeoverComputerSettledState(reason)).toBe(TAKEOVER_COMPUTER_DONE_STATE);
    }
    for (const reason of ["skipped", "expired", "takeover-skipped"]) {
      expect(takeoverComputerSettledState(reason)).toBe(TAKEOVER_COMPUTER_SKIPPED_STATE);
    }
  });
});
