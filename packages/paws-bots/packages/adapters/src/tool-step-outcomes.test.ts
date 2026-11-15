import type { HistoryToolStep, RunTrigger } from "@rakazo/contracts";
import { RUN_TRIGGERS } from "@rakazo/contracts";
import { appendToolCallSegment } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { ReplyState, RunContext } from "./run-context.js";
import { redactBlocks } from "./run-messages.js";
import { withReplyToolOutcomes } from "./run-progress.js";
import { toolCompletionOutcome } from "./tool-completion-audit.js";
import {
  historyReplaysOutsideContent,
  keepToolStepResult,
  keptToolArguments,
  keptToolResult,
  runReplaysToolHistory,
  saveLatestStepScreenshot,
  TOOL_CALL_TEXT_MAX_CHARS,
  TOOL_REPLY_RESULTS_MAX_CHARS,
} from "./tool-step-calls.js";

const base = { name: "shell", executionId: "call-1", durationMs: 5 };

describe("tool step outcomes", () => {
  it("reads success, a thrown or reported error, and a pause from a completion", () => {
    expect(toolCompletionOutcome({ ...base, result: { content: [] } })).toBe("succeeded");
    expect(toolCompletionOutcome({ ...base, error: new Error("boom") })).toBe("failed");
    expect(
      toolCompletionOutcome({
        ...base,
        result: { content: [{ type: "text", text: "no" }], details: { isError: true } },
      }),
    ).toBe("failed");
    expect(toolCompletionOutcome({ ...base, paused: true })).toBeUndefined();
  });

  it("fails a command that ran but exited non-zero", () => {
    const shell = (code: number) => ({ ...base, result: { stdout: "", stderr: "x", code } });
    expect(toolCompletionOutcome(shell(0))).toBe("succeeded");
    expect(toolCompletionOutcome(shell(1))).toBe("failed");
    expect(toolCompletionOutcome(shell(127))).toBe("failed");
    expect(
      toolCompletionOutcome({ ...base, result: { content: [], details: { exitCode: 2 } } }),
    ).toBe("failed");
  });

  it("saves each call's outcome on its step, and counts unfinished calls when stopped", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1" },
        { label: "Shell", executionId: "call-2" },
      ],
      toolOutcomes: new Map([["call-1", "succeeded" as const]]),
      toolStepCalls: new Map(),
      keptResultChars: 0,
    } as unknown as ReplyState;
    expect(withReplyToolOutcomes(reply)).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1 } }],
      },
    ]);
    expect(withReplyToolOutcomes(reply, "stopped")).toEqual([
      {
        kind: "steps",
        steps: [{ label: "Shell", count: 2, outcomes: { succeeded: 1, stopped: 1 } }],
      },
    ]);
  });

  it("keeps each call's arguments and the start of its result on its step", () => {
    const reply = {
      messageSegments: appendToolCallSegment(appendToolCallSegment([], "shell"), "shell"),
      toolCalls: [
        { label: "Shell", executionId: "call-1", tool: "shell" },
        { label: "Shell", executionId: "call-2", tool: "shell" },
      ],
      toolOutcomes: new Map([
        ["call-1", "succeeded" as const],
        ["call-2", "failed" as const],
      ]),
      toolStepCalls: new Map([
        ["call-1", { arguments: keptToolArguments({ command: "ls" }, []) }],
        ["call-2", { arguments: keptToolArguments({ command: "npm -v" }, []) }],
      ]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    keepToolStepResult(
      reply,
      { ...base, result: { content: [{ type: "text", text: '{"stdout":"a\\n","code":0}' }] } },
      [],
    );
    keepToolStepResult(
      reply,
      { ...base, executionId: "call-2", error: new Error("npm: command not found") },
      [],
    );
    expect(withReplyToolOutcomes(reply)).toEqual([
      {
        kind: "steps",
        steps: [
          {
            label: "Shell",
            tool: "shell",
            count: 2,
            calls: [
              { arguments: '{"command":"ls"}', result: '{"stdout":"a\\n","code":0}' },
              { arguments: '{"command":"npm -v"}', result: "npm: command not found", failed: true },
            ],
            outcomes: { succeeded: 1, failed: 1 },
          },
        ],
      },
    ]);
    // A step whose calls are not all kept (a connector call that made several) keeps none.
    reply.toolStepCalls.delete("call-2");
    const [block] = withReplyToolOutcomes(reply);
    expect(
      block?.kind === "steps" ? (block.steps[0] as HistoryToolStep).calls : "not steps",
    ).toBeUndefined();
  });

  it("keeps what a call really was and returned, redacted, bounded to its start and end", () => {
    const args = JSON.parse(
      keptToolArguments(
        {
          command: `curl -H "Authorization: Bearer abc.def" https://x.test?k=run-secret ${"y".repeat(500)}`,
          api_key: "sk-live-123",
          items: Array.from({ length: 50 }, (_, index) => index),
        },
        ["run-secret"],
      )!,
    );
    expect(args.command).not.toContain("run-secret");
    expect(args.command).not.toContain("abc.def");
    // Ordinary arguments are kept whole.
    expect(args.command).toContain("y".repeat(500));
    expect(args.items).toHaveLength(50);
    expect(args.api_key).toBe("[redacted]");
    const long = `token=run-secret ${"a".repeat(5_000)} exit status 0`;
    const result = keptToolResult(
      { ...base, result: { content: [{ type: "text", text: long }] } },
      ["run-secret"],
    )!;
    expect(result).not.toContain("run-secret");
    // A long result keeps its start and its end, and says how much was left out.
    expect(result).toMatch(/^token=\[redacted\]/);
    expect(result).toMatch(/exit status 0$/);
    expect(result).toMatch(/\[\d+ characters not kept\]/);
    expect(result.length).toBeLessThanOrEqual(TOOL_CALL_TEXT_MAX_CHARS + 60);
    // A short result is kept as it was.
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "text", text: "ok" }] } }, []),
    ).toBe("ok");
    // A screenshot keeps only that it was an image; a secret tool's result is not kept.
    expect(
      keptToolResult({ ...base, result: { content: [{ type: "image", data: "x" }] } }, []),
    ).toBe("[image not kept]");
    expect(
      keptToolResult(
        { ...base, name: "generate_secret", result: { content: [{ type: "text", text: "v" }] } },
        [],
      ),
    ).toBeUndefined();
  });

  it("redacts a secret learned later from calls already kept, when the reply is saved", () => {
    const step: HistoryToolStep = {
      label: "Shell",
      tool: "shell",
      count: 1,
      calls: [
        {
          arguments: '{"command":"echo late-secret"}',
          result: "late-secret",
          image: { artifactId: "shot" },
        },
      ],
    };
    const [block] = redactBlocks(
      [
        {
          kind: "steps",
          steps: [step],
        },
      ],
      ["late-secret"],
    );
    expect(JSON.stringify(block)).not.toContain("late-secret");
    const [call] = block?.kind === "steps" ? (block.steps[0] as HistoryToolStep).calls! : [];
    expect(JSON.parse(call!.arguments!)).toEqual({
      command: "echo [redacted]",
    });
    // The kept screenshot stays with its call.
    expect(call!.image).toEqual({
      artifactId: "shot",
    });
  });

  it("redacts credentials a tool returned in JSON fields", () => {
    const result = keptToolResult(
      {
        ...base,
        result: {
          content: [
            { type: "text", text: '{"user":"ana","password":"hunter2","api_key":"k-123"}' },
          ],
        },
      },
      [],
    );
    expect(result).toBe('{"user":"ana","password":"[redacted]","api_key":"[redacted]"}');
  });

  it("replays tool calls only to runs the owner started themselves, failing closed", () => {
    const owner = { fromUser: true, nonOwnerChat: false };
    // Every trigger, so a new one must be decided here; any not allowed gets plain step labels.
    const expected: Record<RunTrigger, boolean> = {
      user: true,
      call_end: true,
      follow_up: true,
      messaging: true,
      routine: false,
      resume: false,
      reaction: false,
      spawn: false,
      skill: false,
      bot_message: false,
      webhook: false,
      cloud_agent: false,
      purchase: false,
      media: false,
      created: false,
      tickets: false,
      helper: false,
      helper_result: false,
    };
    expect(Object.keys(expected).sort()).toEqual([...RUN_TRIGGERS].sort());
    for (const trigger of RUN_TRIGGERS)
      expect([trigger, runReplaysToolHistory(trigger, owner)]).toEqual([
        trigger,
        expected[trigger],
      ]);
    expect(runReplaysToolHistory("a-trigger-added-later", owner)).toBe(false);
    // Answering a paused run's question requeues that same run with its original trigger and
    // source, so a resume gets the original's decision; "resume" alone traces to no original.
    expect(runReplaysToolHistory("user", owner)).toBe(true);
    expect(runReplaysToolHistory("bot_message", owner)).toBe(false);
    expect(runReplaysToolHistory("resume", owner)).toBe(false);
    // A follow-up the bot queued, a channel, or another person in a team chat never gets them.
    expect(runReplaysToolHistory("follow_up", { fromUser: false, nonOwnerChat: false })).toBe(
      false,
    );
    for (const trigger of ["messaging", "user"])
      expect(runReplaysToolHistory(trigger, { fromUser: true, nonOwnerChat: true })).toBe(false);
  });

  it("holds a result that arrives before its call is kept, for the call's handler", () => {
    const reply = { toolStepCalls: new Map(), keptResultChars: 0 } as unknown as ReplyState;
    const done = { ...base, result: { content: [{ type: "text", text: "fast" }] } };
    keepToolStepResult(reply, done, []);
    expect(reply.toolStepCalls.size).toBe(0);
    expect(reply.earlyCompletions?.get("call-1")).toBe(done);
  });

  it("marks a call that exited non-zero as failed, like its step's outcome", () => {
    const reply = {
      toolStepCalls: new Map([["call-1", { arguments: "{}" }]]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    keepToolStepResult(
      reply,
      {
        ...base,
        result: { content: [{ type: "text", text: "no such file" }], details: { exitCode: 2 } },
      },
      [],
    );
    expect(reply.toolStepCalls.get("call-1")).toMatchObject({ failed: true });
  });

  it("keeps no more than a reply's result budget, then only how later calls ended", () => {
    const reply = { toolStepCalls: new Map(), keptResultChars: 0 } as unknown as ReplyState;
    const big = { content: [{ type: "text", text: "x".repeat(10_000) }] };
    const calls = Math.ceil(TOOL_REPLY_RESULTS_MAX_CHARS / TOOL_CALL_TEXT_MAX_CHARS) + 2;
    for (let index = 0; index < calls; index++) {
      reply.toolStepCalls.set(`call-${index}`, { arguments: "{}" });
      keepToolStepResult(reply, { ...base, executionId: `call-${index}`, result: big }, []);
    }
    const kept = [...reply.toolStepCalls.values()].map((call) => call.result?.length);
    expect(kept.slice(0, 3).every((length) => length! >= TOOL_CALL_TEXT_MAX_CHARS)).toBe(true);
    expect(kept.at(-1)).toBeUndefined();
    expect(reply.toolStepCalls.get(`call-${calls - 1}`)).toEqual({ arguments: "{}" });
    // Each kept result may add its short "characters not kept" marker to its share.
    expect(reply.keptResultChars).toBeLessThanOrEqual(TOOL_REPLY_RESULTS_MAX_CHARS + 100);
  });

  it("starts a run as having read outside content when history replays a kept outside result", () => {
    const reply = (tool: string, call: Record<string, unknown>) => [
      {
        role: "assistant" as const,
        content: "Done.",
        segments: [{ steps: [{ label: "Step", count: 1, tool, calls: [call] }] }],
      },
    ];
    // A fetched page's text could carry injected instructions into the later turn.
    expect(
      historyReplaysOutsideContent(reply("web_fetch", { arguments: "{}", result: "<page text>" })),
    ).toBe(true);
    expect(
      historyReplaysOutsideContent(
        reply("computer_observe", { arguments: "{}", image: { artifactId: "a" } }),
      ),
    ).toBe(true);
    // A saved page read back holds what an earlier run copied in, so any kept result counts.
    expect(
      historyReplaysOutsideContent(
        reply("save_page", { arguments: '{"pageId":"p1"}', result: "<page source>" }),
      ),
    ).toBe(true);
    // A call with nothing kept adds no outside text.
    expect(historyReplaysOutsideContent(reply("web_fetch", { arguments: "{}" }))).toBe(false);
    expect(historyReplaysOutsideContent([{ role: "user", content: "Hi" }])).toBe(false);
  });

  it("saves the reply's last screenshot as a hidden artifact and points its call at it", async () => {
    const reply = {
      toolStepCalls: new Map([
        ["call-1", { arguments: "{}" }],
        ["call-2", { arguments: "{}" }],
      ]),
      keptResultChars: 0,
    } as unknown as ReplyState;
    const shot = (byte: number) => ({
      content: [
        { type: "text", text: "computer observed" },
        { type: "image", data: Buffer.from([byte]).toString("base64"), mimeType: "image/png" },
      ],
    });
    keepToolStepResult(reply, { ...base, name: "computer_observe", result: shot(1) }, []);
    keepToolStepResult(
      reply,
      { ...base, name: "computer_observe", executionId: "call-2", result: shot(2) },
      [],
    );
    // Only the latest screenshot of the reply is kept.
    expect(reply.latestScreenshot).toMatchObject({ executionId: "call-2", mimeType: "image/png" });
    const create = vi.fn(async ({ data }: { data: { mimeType: string } }) => ({
      id: "shot-1",
      ...data,
    }));
    const put = vi.fn(async () => ({ id: "storage-1" }));
    const ctx = {
      deps: {
        prisma: { artifact: { findFirst: vi.fn(async () => null), create } },
        artifacts: { put, remove: vi.fn() },
      },
      run: { spaceId: "space-1", userId: "user-1" },
      bot: { id: "bot-1" },
      thread: { groupId: null },
      runId: "run-1",
      state: { reply },
    } as unknown as RunContext;
    await saveLatestStepScreenshot(ctx);
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "image/png;profile=step-screenshot",
        bytes: new Uint8Array([2]),
      }),
      expect.anything(),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      runId: "run-1",
      mimeType: "image/png;profile=step-screenshot",
    });
    expect(reply.toolStepCalls.get("call-2")).toMatchObject({ image: { artifactId: "shot-1" } });
    expect(reply.toolStepCalls.get("call-1")?.image).toBeUndefined();
    expect(reply.latestScreenshot).toBeUndefined();
  });
});
