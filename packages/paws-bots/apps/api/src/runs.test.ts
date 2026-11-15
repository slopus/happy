import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPreview } from "./runs.js";

describe("run activity copy", () => {
  it.each([
    [
      "request",
      "Maya",
      "Please check the release workflow.",
      "Maya asked: Please check the release workflow.",
      "request",
    ],
    ["result", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["status", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["fyi", "Maya", "Ready", "Update from Maya: Ready", "update"],
    ["request", "  ", " first\n second ", "Another agent asked: first second", "request"],
    ["result", "  ", " first\n second ", "Update from Another agent: first second", "update"],
    ["request", " Maya ", " \n ", "Maya asked", "request"],
    ["result", " Maya ", "", "Update from Maya", "update"],
    ["request", "", "", "Another agent asked", "request"],
    ["result", "", "", "Update from Another agent", "update"],
  ])(
    "preserves the legacy label for %s from '%s' with text '%s'",
    (intent, fromBotName, text, legacy, kind) => {
      expect(
        activityPreview({
          trigger: "bot_message",
          prompt: "[bot] private internal routing envelope",
          sourceBlocks: [
            { kind: "bot_message_received", fromBotId: "peer", fromBotName, text, intent },
          ],
        }),
      ).toEqual({
        promptSnippet: legacy,
        agentMessage: {
          fromBotName: fromBotName.trim(),
          kind,
          text: text.replace(/\s+/g, " ").trim(),
        },
      });
    },
  );

  it("caps the whole legacy label and the structured text independently", () => {
    expect(activityPreview({ trigger: "user", prompt: " hello\n world " })).toEqual({
      promptSnippet: "hello world",
      agentMessage: null,
    });
    const preview = activityPreview({
      trigger: "bot_message",
      prompt: "internal",
      sourceBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer",
          fromBotName: "Peer",
          intent: "request",
          text: "x".repeat(130),
        },
      ],
    });
    expect(preview).toEqual({
      promptSnippet: `Peer asked: ${"x".repeat(107)}…`,
      agentMessage: { fromBotName: "Peer", kind: "request", text: `${"x".repeat(119)}…` },
    });
    expect(activityPreview({ trigger: "user", prompt: "x".repeat(130) }).promptSnippet).toBe(
      `${"x".repeat(119)}…`,
    );
  });

  it("keeps surrogate pairs intact at the activity preview boundary", () => {
    const emoji = "\u{1f600}";
    const preview = (prompt: string) => activityPreview({ trigger: "user", prompt }).promptSnippet;
    expect(preview("a".repeat(118) + emoji)).toBe("a".repeat(118) + emoji);
    expect(preview("a".repeat(118) + emoji + "x")).toBe("a".repeat(118) + "\u2026");
    expect(preview("a".repeat(117) + emoji + "xx")).toBe("a".repeat(117) + emoji + "\u2026");
  });

  it("keeps structured agent message text intact at the same boundary", () => {
    const text = "a".repeat(118) + "\u{1f600}x";
    const preview = activityPreview({
      trigger: "bot_message",
      prompt: "internal",
      sourceBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer",
          fromBotName: "Peer",
          text,
          intent: "request",
        },
      ],
    });
    expect(preview.agentMessage).toEqual({
      fromBotName: "Peer",
      kind: "request",
      text: "a".repeat(118) + "\u2026",
    });
  });

  it.each([
    undefined,
    null,
    [],
    [{ kind: "invalid" }],
    [{ kind: "text", text: "not a peer message" }],
  ])("fails closed when an agent message has no valid structured source: %j", (sourceBlocks) => {
    expect(
      activityPreview({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks,
      }),
    ).toEqual({ promptSnippet: "Message from another agent", agentMessage: { kind: "unknown" } });
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

it("hides opaque sender names in Activity previews", () => {
  expect(
    activityPreview({
      trigger: "bot_message",
      prompt: "internal",
      sourceBlocks: [
        {
          kind: "bot_message_received",
          fromBotId: "peer",
          fromBotName: "__TestTok1__",
          text: "Ready",
          intent: "result",
        },
      ],
    }),
  ).toEqual({
    promptSnippet: "Update from Another agent: Ready",
    agentMessage: { fromBotName: "", kind: "update", text: "Ready" },
  });
});
