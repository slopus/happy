import { describe, expect, it } from "vitest";
import { RunSchema } from "./domain.js";
import {
  providerQuotaResetAt,
  RUN_TRIGGERS,
  RunActivityRowSchema,
  RunTriggerSchema,
} from "./runs.js";

describe("run triggers", () => {
  it("accepts every shared trigger in the run output schemas", () => {
    for (const trigger of RUN_TRIGGERS) {
      expect(RunTriggerSchema.parse(trigger)).toBe(trigger);
      expect(
        RunSchema.parse({
          id: "run-1",
          botId: "bot-1",
          threadId: "thread-1",
          taskId: "task-1",
          status: "running",
          trigger,
          routineId: null,
          modelProvider: null,
          modelId: null,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
      expect(
        RunActivityRowSchema.parse({
          runId: "run-1",
          botId: "bot-1",
          botName: "Helper",
          groupId: null,
          groupName: null,
          threadId: "thread-1",
          status: "running",
          trigger,
          notificationsEnabled: false,
          agentMessage: null,
          promptSnippet: "",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }).trigger,
      ).toBe(trigger);
    }
  });
});

describe("activity message metadata", () => {
  const row = {
    runId: "run-1",
    botId: "bot-1",
    botName: "Helper",
    groupId: null,
    groupName: null,
    threadId: "thread-1",
    status: "running",
    trigger: "bot_message",
    notificationsEnabled: false,
    promptSnippet: "Ready",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  it("requires nullable metadata and accepts structured text or an unknown source", () => {
    expect(RunActivityRowSchema.safeParse(row).success).toBe(false);
    expect(RunActivityRowSchema.safeParse({ ...row, agentMessage: null }).success).toBe(true);
    for (const agentMessage of [
      { fromBotName: "", kind: "update", text: "" },
      { fromBotName: "Peer", kind: "request", text: "x".repeat(120) },
      { kind: "unknown" },
    ]) {
      expect(RunActivityRowSchema.parse({ ...row, agentMessage }).agentMessage).toEqual(
        agentMessage,
      );
    }
  });

  it.each([
    { fromBotName: "Peer", kind: "invalid", text: "Ready" },
    { fromBotName: "Peer", kind: "update" },
    { fromBotName: "Peer", kind: "request", text: null },
    { fromBotName: "Peer", kind: "update", text: "x".repeat(121) },
    { fromBotName: "Peer", kind: "request", text: "Ready", extra: true },
    { kind: "unknown", text: "internal" },
  ])("rejects invalid or extra metadata: %j", (agentMessage) => {
    expect(RunActivityRowSchema.safeParse({ ...row, agentMessage }).success).toBe(false);
  });
});

describe("providerQuotaResetAt", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const tomorrow = Date.parse("2026-10-31T00:00:00Z");
  const body = (headers: Record<string, string>) =>
    `429 ${JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429, metadata: { headers } } })}`;

  it.each([
    ["an epoch in milliseconds", body({ "X-RateLimit-Reset": String(tomorrow) }), tomorrow],
    ["an epoch in seconds", body({ "X-RateLimit-Reset": String(tomorrow / 1000) }), tomorrow],
    ["a Retry-After in seconds", body({ "Retry-After": "7200" }), now + 7_200_000],
    [
      "a header copied into an envelope",
      JSON.stringify({ primaryError: body({ "X-RateLimit-Reset": String(tomorrow) }) }),
      tomorrow,
    ],
  ])("reads %s", (_label, text, expected) => {
    expect(providerQuotaResetAt(text, now)).toBe(expected);
  });

  it.each([
    ["a reset within the hour", body({ "X-RateLimit-Reset": String(now + 60_000) })],
    ["a reset in the past", body({ "X-RateLimit-Reset": String(now - 60_000) })],
    ["a short Retry-After", body({ "Retry-After": "30" })],
    ["no reset", '429: {"message":"Rate limit reached"}'],
  ])("ignores %s", (_label, text) => {
    expect(providerQuotaResetAt(text, now)).toBeUndefined();
  });
});
