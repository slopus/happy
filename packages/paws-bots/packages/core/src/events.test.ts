import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  appendTextSegment,
  appendToolCallSegment,
  appendToolStep,
  appToolLabel,
  containsSecret,
  createStreamingRedactor,
  endsSentence,
  humanizeToolName,
  isRunTerminalEvent,
  liveActivityLine,
  normalizeResponseStreamingPreference,
  noteLastToolStep,
  projectMessages,
  redactSecrets,
  redactSecretsAfter,
  reduceLiveMessageBlocks,
  responseStreamingEnabled,
  runFailureError,
  sanitizeJsonValue,
  sanitizeUtf16ForJson,
  splitToolHistory,
  stripLiveStreamingProgress,
  toolNameFromLabel,
  trackToolCallStreak,
  trackToolNameStreak,
  withLiveStreamingProgress,
  withoutLastToolStepNotes,
  withToolHistory,
  withToolStepOutcomes,
} from "./events.js";
import { modelFallbackFailure, normalizeRunError } from "./run-error.js";

describe("containsSecret", () => {
  it("detects secrets that JSON escaping changes", () => {
    expect(containsSecret({ 'api"key': { nested: 'api"key' } }, ['api"key'])).toBe(true);
    expect(containsSecret({ nested: ["line\nbreak"] }, ["line\nbreak"])).toBe(true);
  });

  it("does not confuse escaped text with the original control character", () => {
    expect(containsSecret({ value: "literal\\ntext" }, ["\n"])).toBe(false);
  });
});

describe("isRunTerminalEvent", () => {
  it("recognizes every terminal run outcome", () => {
    expect(isRunTerminalEvent({ type: "run.completed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.failed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.cancelled" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.waiting_input" })).toBe(false);
  });
});

describe("response streaming preference", () => {
  it("enables streaming only for an explicit on value", () => {
    expect(normalizeResponseStreamingPreference("on")).toBe("on");
    expect(normalizeResponseStreamingPreference(" ON ")).toBe("on");
    expect(normalizeResponseStreamingPreference("off")).toBe("off");
    expect(normalizeResponseStreamingPreference(" OFF ")).toBe("off");
    expect(normalizeResponseStreamingPreference("")).toBe("off");
    expect(normalizeResponseStreamingPreference(null)).toBe("off");
    expect(normalizeResponseStreamingPreference("maybe")).toBe("off");
    expect(responseStreamingEnabled()).toBe(false);
    expect(responseStreamingEnabled("off")).toBe(false);
    expect(responseStreamingEnabled("on")).toBe(true);
  });

  it("strips live token bubbles and leaves tool activity", () => {
    const messages = [
      {
        id: "m1",
        blocks: [{ kind: "text" as const, text: "hi" }],
      },
      {
        id: "progress:run-1",
        blocks: [{ kind: "progress" as const, text: "Lisbon" }],
      },
      {
        id: "progress:run-2",
        blocks: [
          { kind: "progress" as const, text: "partial" },
          { kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] },
        ],
      },
      {
        id: "progress:run-3",
        blocks: [{ kind: "progress" as const, text: "Using browser", activity: true as const }],
      },
    ];
    expect(stripLiveStreamingProgress(messages)).toEqual([
      messages[0],
      {
        id: "progress:run-2",
        blocks: [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }],
      },
      messages[3],
    ]);
  });

  it("strips flushed narration text from synthetic progress messages", () => {
    const durable = {
      id: "m-final",
      blocks: [{ kind: "text" as const, text: "Lisbon is the capital of Portugal." }],
    };
    const live = {
      id: "progress:run-1",
      blocks: [
        { kind: "text" as const, text: "I'm checking that now." },
        { kind: "steps" as const, steps: [{ label: "Browser", count: 1 }] },
        { kind: "progress" as const, text: "Lisbon is the cap" },
      ],
    };
    expect(stripLiveStreamingProgress([durable, live])).toEqual([
      durable,
      {
        id: "progress:run-1",
        blocks: [{ kind: "steps" as const, steps: [{ label: "Browser", count: 1 }] }],
      },
    ]);
  });

  it("returns the same snapshot when streaming is on or there is nothing to strip", () => {
    const snapshot = {
      messages: [{ id: "m1", blocks: [{ kind: "text" as const, text: "done" }] }],
    };
    expect(withLiveStreamingProgress(snapshot, true)).toBe(snapshot);
    expect(withLiveStreamingProgress(snapshot, false)).toBe(snapshot);
    expect(withLiveStreamingProgress(null, false)).toBeNull();
  });
});

describe("reduceLiveMessageBlocks", () => {
  it("preserves structured live activity markers", () => {
    expect(
      reduceLiveMessageBlocks([], {
        type: "progress",
        payload: { text: "Using browser", activity: true },
      }),
    ).toEqual([{ kind: "progress", text: "Using browser", activity: true }]);
  });

  it("replaces punctuated activity text with its tool step", () => {
    const activity = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Running: echo done.", activity: true },
    });

    expect(reduceLiveMessageBlocks(activity, { type: "tool", name: "shell" })).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("keeps a tool waiting on an unfinished sentence when a reset drops the text", () => {
    let blocks = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Checking totals" },
    });
    blocks = reduceLiveMessageBlocks(blocks, { type: "tool", name: "shell" });
    blocks = reduceLiveMessageBlocks(blocks, {
      type: "progress",
      payload: { reset: true, text: "Checking totals", activity: true },
    });
    expect(blocks).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "Checking totals", activity: true },
    ]);
  });

  it("drops streamed text on a reset, keeps the steps, and shows the note as the working line", () => {
    let blocks = reduceLiveMessageBlocks([], {
      type: "progress",
      payload: { text: "Checking the totals." },
    });
    blocks = reduceLiveMessageBlocks(blocks, { type: "tool", name: "shell" });
    blocks = reduceLiveMessageBlocks(blocks, {
      type: "progress",
      payload: { reset: true, text: "Checking the totals.", activity: true },
    });
    expect(blocks).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "Checking the totals.", activity: true },
    ]);
    expect(liveActivityLine([{ id: "progress:run-1", blocks }])).toBe("Checking the totals.");
    // The next text the bot writes replaces the working line.
    expect(
      reduceLiveMessageBlocks(blocks, { type: "progress", payload: { text: "They match." } }),
    ).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "They match." },
    ]);
  });
});

describe("runFailureError", () => {
  it("returns the error only for run.failed with a real message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "provider missing" } })).toBe(
      "provider missing",
    );
    expect(runFailureError({ type: "run.failed", payload: {} })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: "   " } })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: 42 } })).toBeNull();
    expect(runFailureError({ type: "run.failed" })).toBeNull();
    expect(runFailureError({ type: "run.completed", payload: { error: "nope" } })).toBeNull();
    expect(runFailureError({ type: "run.cancelled", payload: { error: "nope" } })).toBeNull();
  });

  it("trims surrounding space and clamps a runaway message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "  spaced  " } })).toBe(
      "spaced",
    );
    const long = runFailureError({ type: "run.failed", payload: { error: "x".repeat(400) } });
    expect(long).toHaveLength(301);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("clamps each model's diagnostic so an exhausted backup chain stays readable", () => {
    const error = modelFallbackFailure("Request timed out.", [
      {
        provider: "fake-provider",
        modelId: "fake-model",
        status: "failed",
        reason: "x".repeat(400),
      },
      { provider: "fake-provider", modelId: "fake-other", status: "failed", reason: "Timeout" },
    ]);
    const shown = runFailureError({ type: "run.failed", payload: { error } });
    expect(normalizeRunError(shown!).summary).toBe(
      "Your model provider took too long to respond. Try again. Your backup models also failed.",
    );
    expect(normalizeRunError(shown!).details).toBe(
      `Request timed out.\nfake-provider fake-model: ${"x".repeat(300)}…\nfake-provider fake-other: Timeout`,
    );
  });
});

describe("projectMessages", () => {
  it("replays durable messages and trailing live tokens from progress events", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "hi" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lis", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "bon", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "hi" });
    expect(messages[1]?.blocks[0]).toEqual({ kind: "progress", text: "Lisbon" });
  });

  it("drops streaming tokens once the completed message is durable", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Lisbon", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: { messageId: "m2", role: "bot", blocks: [{ kind: "text", text: "Lisbon" }] },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({ kind: "text", text: "Lisbon" });
  });

  it("keeps live subagent cards until a durable subagent message arrives", () => {
    const live = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
          progress: "working…",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(live).toHaveLength(1);
    expect(live[0]?.blocks[0]).toMatchObject({
      kind: "subagent",
      name: "helper",
      status: "running",
    });

    const durable = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.subagent",
        runId: "r1",
        payload: {
          agentId: "a1",
          name: "helper",
          task: "summarize",
          status: "running",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.message.created",
        runId: "r1",
        payload: {
          messageId: "m1",
          role: "bot",
          blocks: [
            {
              kind: "subagent",
              agentId: "a1",
              name: "helper",
              task: "summarize",
              status: "completed",
              result: "ok",
            },
          ],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(durable).toHaveLength(1);
    expect(durable[0]?.blocks[0]).toMatchObject({ status: "completed", result: "ok" });
  });

  it("drops prior history when a later clear event is replayed", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.message.created",
        payload: { messageId: "m1", role: "user", blocks: [{ kind: "text", text: "old" }] },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "draft" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.cleared",
        payload: {},
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toEqual([]);
  });

  it("collapses repeated tool calls into one step with a count", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FETCH_CONVERSATION_HISTORY" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks[0]).toEqual({
      kind: "steps",
      steps: [
        { label: "Slack fetch conversation history", count: 2 },
        { label: "Slack find channels", count: 1 },
      ],
    });
  });

  it("holds a tool call that lands mid-sentence until the sentence completes", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check Slack ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "for a broad search.", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // The sentence only finishes once "for a broad search." streams in, so the completed
    // sentence and the held-back tool call appear together, in that order.
    expect(messages[0]?.blocks).toEqual([
      { kind: "text", text: "Let me check Slack for a broad search." },
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("places a tool before response text when no narration preceded it", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "The check passed.", streaming: true },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(messages[0]?.blocks).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "progress", text: "The check passed." },
    ]);
  });

  it("keeps a tool call hidden while narration keeps streaming with no sentence end", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Let me check what I have ", streaming: true },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        seq: 2,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "locally and try the GitHub API", streaming: true },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    ]);
    expect(messages).toHaveLength(1);
    // No sentence terminator has streamed in yet, so the "Shell" call stays hidden and
    // everything so far renders as one continuous progress tail.
    expect(messages[0]?.blocks).toEqual([
      {
        kind: "progress",
        text: "Let me check what I have locally and try the GitHub API",
        pendingToolNames: ["shell"],
      },
    ]);
  });

  it("keeps interleaved group runs and their tool calls isolated", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        botId: "bot-a",
        seq: 0,
        type: "thread.progress",
        runId: "r1",
        payload: { text: "Alpha " },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        botId: "bot-b",
        seq: 1,
        type: "thread.progress",
        runId: "r2",
        payload: { text: "Beta." },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        id: "e3",
        threadId: "t1",
        botId: "bot-a",
        seq: 2,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "shell" },
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      {
        id: "e4",
        threadId: "t1",
        botId: "bot-b",
        seq: 3,
        type: "agent.tool.called",
        runId: "r2",
        payload: { name: "read_file" },
        createdAt: "2026-01-01T00:00:03.000Z",
      },
      {
        id: "e5",
        threadId: "t1",
        botId: "bot-a",
        seq: 4,
        type: "thread.progress",
        runId: "r1",
        payload: { delta: "done." },
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "progress:r1",
        botId: "bot-a",
        blocks: [
          { kind: "text", text: "Alpha done." },
          { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        ],
      }),
      expect.objectContaining({
        id: "progress:r2",
        botId: "bot-b",
        blocks: [
          { kind: "text", text: "Beta." },
          { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        ],
      }),
    ]);
  });

  it("clears the live step trail once the run ends", () => {
    const messages = projectMessages([
      {
        id: "e1",
        threadId: "t1",
        seq: 0,
        type: "agent.tool.called",
        runId: "r1",
        payload: { name: "SLACK_FIND_CHANNELS" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "e2",
        threadId: "t1",
        seq: 1,
        type: "run.cancelled",
        runId: "r1",
        payload: {},
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    expect(messages).toHaveLength(0);
  });
});

describe("toolNameFromLabel", () => {
  it("turns a displayed name back into the tool name", () => {
    expect(toolNameFromLabel(" Write  file ")).toBe("Write_file");
    expect(toolNameFromLabel("write_file")).toBe("write_file");
  });
});

describe("appToolLabel", () => {
  it("drops the app's own prefix only", () => {
    expect(appToolLabel("GMAIL_SEND_EMAIL", "gmail")).toBe("Send email");
    expect(appToolLabel("SLACK_FIND_CHANNELS", "gmail")).toBe("Slack find channels");
  });
});

describe("humanizeToolName", () => {
  it("turns a Composio-style constant into a readable label", () => {
    expect(humanizeToolName("SLACK_FIND_CHANNELS")).toBe("Slack find channels");
  });

  it("turns a lowercase builtin tool name into a readable label", () => {
    expect(humanizeToolName("request_takeover")).toBe("Request takeover");
  });
});

describe("appendToolStep", () => {
  it("starts a new step for the first call", () => {
    expect(appendToolStep([], "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 1 },
    ]);
  });

  it("increments the count when the same tool fires again in a row", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 2 },
    ]);
  });

  it("appends a new step when a different tool fires", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FETCH_CONVERSATION_HISTORY")).toEqual([
      { label: "Slack find channels", count: 1 },
      { label: "Slack fetch conversation history", count: 1 },
    ]);
  });
});

describe("trackToolCallStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(
      trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", { cursor: "a" }),
    ).toMatchObject({ key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}', count: 1 });
  });

  it("increments the count when the same tool and args repeat", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "a" })).toMatchObject({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}',
      count: 2,
    });
  });

  it("resets the streak when the same tool is called with different args", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "b" })).toMatchObject({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"b"}',
      count: 1,
    });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(
      trackToolCallStreak(first, "SLACK_FETCH_CONVERSATION_HISTORY", { cursor: "a" }),
    ).toMatchObject({ key: 'SLACK_FETCH_CONVERSATION_HISTORY:{"cursor":"a"}', count: 1 });
  });

  it("counts calls whose text arguments differ only by digits as one similar streak", () => {
    let streak = trackToolCallStreak({ key: undefined, count: 0 }, "shell", {
      command: "echo noop-1",
    });
    streak = trackToolCallStreak(streak, "shell", { command: "echo noop-22" });
    expect(streak).toMatchObject({ count: 1, shapeCount: 2 });
    streak = trackToolCallStreak(streak, "shell", { command: "echo other-3" });
    expect(streak).toMatchObject({ count: 1, shapeCount: 1 });
  });

  it("does not blank numbers that are not part of a text argument", () => {
    let streak = trackToolCallStreak({ key: undefined, count: 0 }, "read_file", { offset: 1 });
    streak = trackToolCallStreak(streak, "read_file", { offset: 2 });
    expect(streak).toMatchObject({ count: 1, shapeCount: 1 });
  });
});

describe("trackToolNameStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(trackToolNameStreak({ name: undefined, count: 0 }, "shell")).toEqual({
      name: "shell",
      count: 1,
    });
  });

  it("increments the count when the same tool name repeats, even with different arguments", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "shell")).toEqual({ name: "shell", count: 2 });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "recall_memory")).toEqual({
      name: "recall_memory",
      count: 1,
    });
  });
});

describe("endsSentence", () => {
  it("is false mid-clause, with no terminal punctuation", () => {
    expect(endsSentence("Let me check what I have loca")).toBe(false);
  });

  it("is false when the text trails off on whitespace with no punctuation", () => {
    expect(endsSentence("Let me check Slack ")).toBe(false);
  });

  it("is true once the text ends on a sentence terminator", () => {
    expect(endsSentence("Let me check. ")).toBe(true);
    expect(endsSentence("Is that right?")).toBe(true);
    expect(endsSentence('She said "stop!"')).toBe(true);
  });

  it("is true for an empty or whitespace-only string — nothing to protect", () => {
    expect(endsSentence("")).toBe(true);
    expect(endsSentence("   ")).toBe(true);
  });
});

describe("appendTextSegment", () => {
  it("starts a new text segment when there are none", () => {
    expect(appendTextSegment([], "hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("does nothing when the text is empty", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "")).toEqual(segments);
  });

  it("merges into the last segment when it is already text", () => {
    const segments = appendTextSegment([], "a");
    expect(appendTextSegment(segments, "b")).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("starts a new text segment after a steps segment", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "done")).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "text", text: "done" },
    ]);
  });
});

describe("appendToolCallSegment", () => {
  it("starts a new steps segment when there are none", () => {
    expect(appendToolCallSegment([], "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("collapses into the last steps segment for the same tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 2 }] },
    ]);
  });

  it("starts a new steps segment after a text segment", () => {
    const segments = [{ kind: "text" as const, text: "hi" }];
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      { kind: "text", text: "hi" },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("adds a new step entry within the same steps segment for a different tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Slack find channels", count: 1 },
          { label: "Shell", count: 1 },
        ],
      },
    ]);
  });
});

describe("step notes", () => {
  it("puts each note on the step it came before, in order", () => {
    let segments = appendToolCallSegment([], "read_file");
    segments = noteLastToolStep(segments, "The meeting is with Anna.");
    segments = appendToolCallSegment(segments, "read_file");
    segments = appendToolCallSegment(segments, "read_file");
    segments = noteLastToolStep(segments, "Saving it.");
    expect(segments).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 2, note: "The meeting is with Anna." },
          { label: "Read file", count: 1, note: "Saving it." },
        ],
      },
    ]);
  });

  it("leaves text and a message without steps alone", () => {
    const text = [{ kind: "text" as const, text: "hi" }];
    expect(noteLastToolStep(text, "Note.")).toEqual(text);
  });

  it("removes only the newest notes", () => {
    let segments = appendToolCallSegment([], "read_file");
    segments = noteLastToolStep(segments, "One.");
    segments = appendToolCallSegment(segments, "shell");
    segments = noteLastToolStep(segments, "Two.");
    segments = appendToolCallSegment(segments, "shell");
    expect(withoutLastToolStepNotes(segments, 1)).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1, note: "One." },
          { label: "Shell", count: 2 },
        ],
      },
    ]);
  });
});

describe("redactSecretsAfter", () => {
  it("hides the rest of a value that started in the text before", () => {
    expect(redactSecretsAfter("The token is hunter", "abcxyz saved.", ["hunterabcxyz"])).toBe(
      "[redacted] saved.",
    );
    expect(redactSecretsAfter("hunterabcxyz", " and abc", ["hunterabcxyz"])).toBe(" and abc");
    expect(redactSecretsAfter("", "key hunterabcxyz", ["hunterabcxyz"])).toBe("key [redacted]");
  });
});

describe("redactSecrets", () => {
  it("hides a longer value whole when a shorter one appears inside it", () => {
    expect(redactSecrets("password=hunter123xyz", ["123", "hunter123xyz"])).toBe(
      "password=[redacted]",
    );
    expect(redactSecrets("a 123 b", ["123", "hunter123xyz", ""])).toBe("a [redacted] b");
  });

  it("hides values that overlap without one containing the other", () => {
    expect(redactSecrets("x=pre-hunter123xyz;", ["pre-hun", "hunter123xyz"])).toBe("x=[redacted];");
    expect(redactSecrets("abab abab", ["abab"])).toBe("[redacted] [redacted]");
    expect(redactSecrets("aaaaaa", ["aaaa"])).toBe("[redacted]");
    expect(redactSecrets("keyfake-keyfake-", ["fake-", "key"])).toBe(
      "[redacted][redacted][redacted][redacted]",
    );
  });

  it("hides each body line of a multi-line value when output splits or rejoins its lines", () => {
    const key =
      "-----BEGIN FAKE KEY-----\r\nAAAAfakeKeyLineOne01\nBBBBfakeKeyLineTwo02\nshort\n-----END FAKE KEY-----\n";
    expect(redactSecrets(`key: ${key}`, [key])).toBe("key: [redacted]");
    // An unquoted `echo $KEY` joins the lines with spaces.
    expect(
      redactSecrets(
        "-----BEGIN FAKE KEY----- AAAAfakeKeyLineOne01 BBBBfakeKeyLineTwo02 short -----END",
        [key],
      ),
    ).toBe("-----BEGIN FAKE KEY----- [redacted] [redacted] short -----END");
    expect(redactSecrets("tail: BBBBfakeKeyLineTwo02", [key])).toBe("tail: [redacted]");
    expect(containsSecret({ out: "AAAAfakeKeyLineOne01" }, [key])).toBe(true);
    // Short lines and spaced lines like the header also appear in ordinary text.
    expect(containsSecret({ out: "short -----BEGIN FAKE KEY-----" }, [key])).toBe(false);
  });
});

describe("createStreamingRedactor", () => {
  it("hides a value split between skipped text and the next chunk", () => {
    const redactor = createStreamingRedactor(["hunter123xyz"]);
    const before = redactor.push("Checking hunter1");
    redactor.skip();
    const after = redactor.push("23xyz now.") + redactor.finish();
    expect(before).not.toContain("hunter1");
    expect(after).toBe(" now.");
    expect(`${before}${after}`).not.toMatch(/23xyz|hunter/);
  });

  it("drops skipped text without changing what follows", () => {
    const redactor = createStreamingRedactor(["hunter123xyz"]);
    redactor.push("A short note.");
    redactor.skip();
    expect(redactor.push("Next text") + redactor.finish()).toBe("Next text");
  });

  it("never emits a secret split across streaming chunks", () => {
    const redactor = createStreamingRedactor(["fake-secret-123"]);
    const output = [
      redactor.push("before fake-se"),
      redactor.push("cret-123 after"),
      redactor.finish(),
    ].join("");
    expect(output).toBe("before [redacted] after");
    expect(output).not.toContain("fake-secret-123");
  });

  it("hides overlapping values whole, however the text is split", () => {
    const secrets = ["pre-hun", "hunter123xyz", "123"];
    const text = "x=pre-hunter123xyz; y=123; z=hunter123xyz";
    for (let size = 1; size <= text.length; size += 1) {
      const redactor = createStreamingRedactor(secrets);
      let output = "";
      for (let at = 0; at < text.length; at += size)
        output += redactor.push(text.slice(at, at + size));
      output += redactor.finish();
      expect(output).toBe(redactSecrets(text, secrets));
      expect(output).toBe("x=[redacted]; y=[redacted]; z=[redacted]");
    }
  });

  it("shows a long run of a value that overlaps itself as it streams, without holding it", () => {
    const redactor = createStreamingRedactor(["0000"]);
    const outputs = Array.from({ length: 10_000 }, () => redactor.push("0000"));
    // One placeholder as soon as the first match is known; later matches extend it.
    expect(outputs[0]).toBe("[redacted]");
    expect(outputs.slice(1).every((output) => output === "")).toBe(true);
    expect(redactor.push(" done") + redactor.finish()).toBe(" done");
  });

  it("hides a line of a multi-line value split across chunks", () => {
    const redactor = createStreamingRedactor(["header\nAAAAfakeKeyLineOne01\n"]);
    const output = [
      redactor.push("x AAAAfake"),
      redactor.push("KeyLineOne01 y"),
      redactor.finish(),
    ];
    expect(output.join("")).toBe("x [redacted] y");
  });

  it("does not delay chunks when there are no known secrets", () => {
    const redactor = createStreamingRedactor([]);
    expect(redactor.push("hello")).toBe("hello");
    expect(redactor.finish()).toBe("");
  });

  it("buffers a trailing UTF-16 high surrogate until the next chunk completes the emoji", () => {
    const redactor = createStreamingRedactor([]);
    const high = "\uD83D";
    const low = "\uDE00";
    expect(redactor.push(`hello ${high}`)).toBe("hello ");
    expect(redactor.push(`${low} world`)).toBe("😀 world");
    expect(redactor.finish()).toBe("");
  });

  it("does not emit a high surrogate when the secret hold window would split an emoji pair", () => {
    const redactor = createStreamingRedactor(["abcdefghij"]); // length 10
    const high = "\uD83D";
    const low = "\uDE00";
    // safeStartLimit lands between high and low; the pair must stay buffered together.
    expect(redactor.push(`x${high}${low}abcdefgh`)).toBe("x");
    expect(redactor.push("ij done")).toBe("😀[redacted]");
    expect(redactor.finish()).toBe(" done");
  });

  it("replaces an orphaned high surrogate at end of stream", () => {
    const redactor = createStreamingRedactor([]);
    expect(redactor.push("end\uD83D")).toBe("end");
    expect(redactor.finish()).toBe("\uFFFD");
  });
});

describe("sanitizeUtf16ForJson", () => {
  it("keeps complete surrogate pairs and replaces unpaired surrogates", () => {
    expect(sanitizeUtf16ForJson("😀")).toBe("😀");
    expect(sanitizeUtf16ForJson("a\uD83D")).toBe("a\uFFFD");
    expect(sanitizeUtf16ForJson("\uDE00b")).toBe("\uFFFDb");
    expect(sanitizeJsonValue({ delta: "x\uD83D", nested: ["\uDE00"] })).toEqual({
      delta: "x\uFFFD",
      nested: ["\uFFFD"],
    });
  });

  it("replaces NUL characters that Postgres json columns reject", () => {
    expect(sanitizeJsonValue({ output: "a\u0000b", "k\u0000": ["\u0000"] })).toEqual({
      output: "a\uFFFDb",
      "k\uFFFD": ["\uFFFD"],
    });
  });

  it("sanitizes nested object keys and disambiguates collisions after replacement", () => {
    expect(
      sanitizeJsonValue({
        outer: {
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uD83D"]: "ok",
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uDE00"]: "also",
        },
      }),
    ).toEqual({
      outer: {
        "meta\uFFFD": "ok",
        "meta\uFFFD#2": "also",
      },
    });
  });
});

describe("stale helper projection", () => {
  it.each([
    "run.waiting_input",
    "computer.takeover.requested",
    "run.completed",
    "run.failed",
    "run.cancelled",
  ])("settles helpers on %s without reviving them on resume", (type) => {
    const base = {
      id: "fixture",
      threadId: "thread-1",
      runId: "run-1",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const helper = { agentId: "helper", name: "Helper", task: "Check", status: "running" };
    const next = projectMessages([
      { ...base, type: "thread.subagent", payload: helper },
      { ...base, seq: 2, type, payload: {} },
      { ...base, seq: 3, type: "run.started", payload: {} },
      { ...base, seq: 4, type: "thread.subagent", payload: { ...helper, agentId: "resumed" } },
    ]);
    expect(next.find((m) => m.id === "subagent:helper")?.blocks[0]).toMatchObject({
      status: "failed",
      result: "stopped",
    });
    expect(next.find((m) => m.id === "subagent:resumed")?.blocks[0]).toMatchObject({
      status: "running",
    });
  });
});

describe("liveActivityLine", () => {
  it("reads the tool status the live message is showing", () => {
    expect(
      liveActivityLine([
        { id: "m1", blocks: [{ kind: "text", text: "Hi" }] },
        {
          id: "progress:run-1",
          blocks: [{ kind: "progress", text: "Searching the web: injury news", activity: true }],
        },
      ]),
    ).toBe("Searching the web: injury news");
  });

  it("is empty while the bot writes text or has no live message", () => {
    expect(
      liveActivityLine([
        { id: "progress:run-1", blocks: [{ kind: "progress", text: "Checking that first." }] },
      ]),
    ).toBeUndefined();
    expect(
      liveActivityLine([{ id: "m1", blocks: [{ kind: "text", text: "Done" }] }]),
    ).toBeUndefined();
  });
});

describe("withToolStepOutcomes", () => {
  it("tallies each call's outcome on the step it showed as, in order", () => {
    const segments = noteLastToolStep(
      appendToolCallSegment(
        appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
        "web_search",
      ),
      "Looking it up.",
    );
    expect(
      withToolStepOutcomes(segments, [
        { label: "Shell", outcome: "succeeded" },
        { label: "Shell", outcome: "failed" },
        { label: "Web search", outcome: undefined },
      ]),
    ).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Shell", count: 2, outcomes: { succeeded: 1, failed: 1 } },
          { label: "Web search", count: 1, note: "Looking it up." },
        ],
      },
    ]);
  });

  it("leaves the steps as they were when the calls do not line up", () => {
    const segments = appendToolCallSegment([], "shell");
    expect(withToolStepOutcomes(segments, [{ label: "Web search", outcome: "failed" }])).toEqual(
      segments,
    );
    expect(withToolStepOutcomes(segments, [])).toEqual(segments);
  });
});

describe("a reply's kept tool calls", () => {
  it("split off the blocks as one entry per step and merge back unchanged", () => {
    const kept = {
      tool: "shell",
      calls: [{ arguments: '{"command":"ls"}', result: "notes.txt" }],
    };
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Shell", count: 1, ...kept },
          { label: "Web fetch", count: 2 },
        ],
      },
      { kind: "text", text: "Done." },
      { kind: "steps", steps: [{ label: "Shell", count: 1, ...kept }] },
    ] as MessageBlock[];
    const { blocks: shown, toolHistory } = splitToolHistory(blocks);
    expect(JSON.stringify(shown)).not.toMatch(/"tool"|"calls"|notes\.txt/);
    expect(toolHistory).toEqual({ steps: [kept, null, kept] });
    expect(withToolHistory(shown, toolHistory)).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Shell", count: 1, ...kept },
          { label: "Web fetch", count: 2 },
        ],
      },
      { kind: "text", text: "Done." },
      { kind: "steps", steps: [{ label: "Shell", count: 1, ...kept }] },
    ]);
    expect(splitToolHistory(shown).toolHistory).toBeUndefined();
  });
});
