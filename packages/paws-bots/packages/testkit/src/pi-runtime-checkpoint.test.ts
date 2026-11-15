import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MAX_APPROVAL_DETAIL_LENGTH } from "../../adapters/src/approval-ask.js";
import { approvalPausedToolResult } from "../../adapters/src/approval-effect.js";
import { builtinAgentTools } from "../../adapters/src/builtin-tools.js";
import { PiAgentRuntime } from "../../adapters/src/pi-runtime.js";
import type { TurnCheckpoint } from "../../adapters/src/turn-checkpoint.js";
import * as turnCheckpoints from "../../adapters/src/turn-checkpoint.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

type Message = TurnCheckpoint["messages"][number];

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("paused turn context", () => {
  it("keeps checkpointed tool batches parallel without serializing successful calls", async () => {
    const started: string[] = [];
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots: unknown[] = [];
    const serialize = vi.spyOn(turnCheckpoints, "serializeTurnCheckpoint");
    let overlapped = false;
    let timedOut = false;
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tools",
            calls: [
              { id: "read-one", name: "read_file", arguments: { path: "one.txt" } },
              { id: "read-two", name: "read_file", arguments: { path: "two.txt" } },
            ],
          },
        },
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
    });
    try {
      const events = await collect(
        new PiAgentRuntime().run({
          runId: "fixture-parallel",
          botId: "fixture-bot",
          threadId: "fixture-thread",
          instructions: "Read fixtures.",
          prompt: "Read both.",
          history: [],
          model: model.model,
          tools: builtinAgentTools.filter((tool) => tool.name === "read_file"),
          onCheckpoint: async (snapshot) => {
            snapshots.push(snapshot);
          },
          executeTool: async (_name, args) => {
            started.push(String(args.path));
            if (started.length === 2) release();
            await Promise.race([
              bothStarted,
              new Promise((_, reject) =>
                setTimeout(() => {
                  timedOut = started.length < 2;
                  reject(new Error("parallel sibling did not start"));
                }, 500),
              ),
            ]);
            overlapped = true;
            return { ok: true };
          },
        }),
      );
      model.assertComplete();
      expect(started).toHaveLength(2);
      expect(overlapped).toBe(true);
      expect(timedOut).toBe(false);
      expect(snapshots).toHaveLength(2);
      expect(serialize).not.toHaveBeenCalled();
      expect(snapshots.every((snapshot) => typeof snapshot === "function")).toBe(true);
      expect(events.some((event) => event.type === "checkpoint")).toBe(false);
    } finally {
      serialize.mockRestore();
      await model.close();
    }
  });
  it("includes a finished sibling but excludes a late sibling at persistence", async () => {
    const controller = new AbortController();
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const captures = new Map<string, () => string>();
    let saved = "";
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tools",
            calls: [
              { id: "finished", name: "read_file", arguments: { path: "finished.txt" } },
              {
                id: "pending",
                name: "write_file",
                arguments: { path: "fixture.txt", content: "fixture" },
              },
              { id: "late", name: "read_file", arguments: { path: "late.txt" } },
            ],
          },
        },
        {
          expect(request) {
            const results = request.messages.filter((message) => message.role === "tool");
            expect(
              results.find((message) => message.tool_call_id === "finished")?.content,
            ).toContain("finished-evidence");
            expect(results.find((message) => message.tool_call_id === "late")?.content).toContain(
              "outcome is unknown",
            );
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-persistence",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Complete fixtures.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => ["read_file", "write_file"].includes(tool.name)),
      onCheckpoint: async (capture, executionId) => {
        captures.set(executionId, capture);
      },
      executeTool: async (name, args, executionId) => {
        if (name === "write_file") {
          // Let the completed tool's microtasks publish its execution-end event.
          await new Promise<void>((resolve) => setImmediate(resolve));
          saved = captures.get(executionId)!();
          controller.abort();
          releaseLate();
          return approvalPausedToolResult();
        }
        if (args.path === "late.txt") await late;
        return { evidence: "finished-evidence" };
      },
    };
    try {
      await expect(
        collect(new PiAgentRuntime().run(request, { signal: controller.signal })),
      ).rejects.toThrow("aborted");
      const snapshot = JSON.parse(saved);
      expect(
        snapshot.messages
          .filter((message: Message) => message.role === "toolResult")
          .map((message: { toolCallId: string }) => message.toolCallId),
      ).toEqual(["finished"]);
      const replay = vi.fn(async () => ({ ok: true }));
      await collect(
        new PiAgentRuntime().run({ ...request, turnCheckpoint: saved, executeTool: replay }),
      );
      expect(replay).toHaveBeenCalledOnce();
      model.assertComplete();
    } finally {
      releaseLate();
      await model.close();
    }
  });
  it("keeps a sequential tail unstarted until the paused interaction resumes", async () => {
    const executed = vi.fn(async () => ({ ok: true }));
    let capture: (() => string) | undefined;
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tools",
            calls: [
              {
                id: "question",
                name: "ask_user",
                arguments: { question: "Which fixture?", options: ["One", "Two"] },
              },
              { id: "tail", name: "remember", arguments: { content: "Fixture fact" } },
            ],
          },
        },
        { expect() {}, response: { type: "text", text: "Done." } },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-sequential",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Choose and remember.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => ["ask_user", "remember"].includes(tool.name)),
      onCheckpoint: async (snapshot) => {
        capture = snapshot;
      },
      executeTool: executed,
    };
    try {
      await collect(new PiAgentRuntime().run(request));
      expect(executed).not.toHaveBeenCalled();
      const saved = capture!();
      expect(JSON.parse(saved).executionMode).toBe("sequential");
      await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: saved,
          resumeToolResult: { content: [{ type: "text", text: "Two" }] },
        }),
      );
      expect(executed).toHaveBeenCalledOnce();
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
  it("redacts a known run secret in ask_user detail before it is checkpointed or recorded", async () => {
    const secret = "fixture-secret-value-123";
    let capture: (() => string) | undefined;
    const sessionRoot = await mkdtemp(path.join(tmpdir(), "rakazo-ask-detail-"));
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "question",
            name: "ask_user",
            arguments: {
              question: "Send this email?",
              detail: `The token is ${secret}.`,
              options: ["Send it", "Show me first"],
            },
          },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-ask-detail",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Confirm the draft.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      secrets: [secret],
      onCheckpoint: async (snapshot) => {
        capture = snapshot;
      },
    };
    try {
      const events = await collect(
        new PiAgentRuntime({ sessionRoot }).run(request, {
          operationId: "ask-detail",
          traceId: "ask-detail",
          spaceId: "fixture-space",
          userId: "fixture-user",
          signal: new AbortController().signal,
        }),
      );
      // The card itself shows the redacted draft.
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "ask",
          detail: expect.stringContaining("[redacted]"),
        }),
      );
      // The persisted turn checkpoint holds the tool call's arguments.
      const saved = capture!();
      expect(saved).not.toContain(secret);
      expect(saved).toContain("[redacted]");
      // The recorded session transcript holds the streamed tool call.
      const entries = await readdir(sessionRoot, { recursive: true });
      const transcripts = await Promise.all(
        entries
          .filter((entry) => String(entry).endsWith(".jsonl"))
          .map((entry) => readFile(path.join(sessionRoot, String(entry)), "utf8")),
      );
      expect(transcripts.join("\n")).not.toContain(secret);
      model.assertComplete();
    } finally {
      await model.close();
      await rm(sessionRoot, { recursive: true, force: true });
    }
  });
  it("keeps a near-limit secret-bearing detail a valid ask on dispatch and restore", async () => {
    // A short secret expands under redaction ([redacted] is longer), so a draft
    // at the schema limit grows past it once redacted; the capped result must
    // still validate, in live dispatch and again on checkpoint restore.
    const secret = "s3cr3t9";
    const head = `The token is ${secret}. `;
    const detail = head + "x".repeat(MAX_APPROVAL_DETAIL_LENGTH - head.length);
    expect(detail.length).toBe(MAX_APPROVAL_DETAIL_LENGTH);
    let capture: (() => string) | undefined;
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "question",
            name: "ask_user",
            arguments: {
              question: "Send this email?",
              detail,
              options: ["Send it", "Show me first"],
            },
          },
        },
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({
              role: "tool",
              tool_call_id: "question",
            });
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-ask-detail-cap",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Confirm the draft.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      secrets: [secret],
      onCheckpoint: async (snapshot) => {
        capture = snapshot;
      },
    };
    try {
      const events = await collect(new PiAgentRuntime().run(request));
      const ask = events.find((event) => event.type === "ask");
      expect(ask).toMatchObject({ detail: expect.stringContaining("[redacted]") });
      expect(String((ask as { detail?: string } | undefined)?.detail).length).toBeLessThanOrEqual(
        MAX_APPROVAL_DETAIL_LENGTH,
      );
      const saved = capture!();
      expect(saved).not.toContain(secret);
      expect(saved).toContain("[redacted]");
      const resumed = await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: saved,
          resumeToolResult: { content: [{ type: "text", text: "Send it" }] },
        }),
      );
      expect(resumed.at(-1)).toEqual({ type: "done", text: "Done." });
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
  it("keeps a draft at the exact schema limit unchanged", async () => {
    const detail = `${"x".repeat(MAX_APPROVAL_DETAIL_LENGTH - 1)}Z`;
    expect(detail.length).toBe(MAX_APPROVAL_DETAIL_LENGTH);
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "question",
            name: "ask_user",
            arguments: {
              question: "Send this email?",
              detail,
              options: ["Send it", "Show me first"],
            },
          },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-ask-detail-exact",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Confirm the draft.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
    };
    try {
      const events = await collect(new PiAgentRuntime().run(request));
      const ask = events.find((event) => event.type === "ask");
      expect((ask as { detail?: string } | undefined)?.detail).toBe(detail);
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
  it("does not split a surrogate pair when cutting a redacted draft", async () => {
    // The short secret expands under redaction past the limit, so the cut lands
    // inside the emoji's surrogate pair.
    const secret = "q";
    const detail = `${"x".repeat(MAX_APPROVAL_DETAIL_LENGTH - 2)}😀y${secret}`;
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "question",
            name: "ask_user",
            arguments: {
              question: "Send this email?",
              detail,
              options: ["Send it", "Show me first"],
            },
          },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-ask-detail-surrogate",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Confirm the draft.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      secrets: [secret],
    };
    try {
      const events = await collect(new PiAgentRuntime().run(request));
      const capped = String(
        (events.find((event) => event.type === "ask") as { detail?: string } | undefined)?.detail,
      );
      expect(capped.length).toBeLessThanOrEqual(MAX_APPROVAL_DETAIL_LENGTH);
      expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
  it.each([
    ["number", 971334409, "971334409"],
    ["object", { token: "topsecret9" }, "topsecret9"],
  ])(
    "drops a non-string ask_user detail (%s) so nothing unredacted is kept",
    async (_shape, rawDetail, secret) => {
      const sessionRoot = await mkdtemp(path.join(tmpdir(), "rakazo-ask-shape-"));
      let capture: (() => string) | undefined;
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "question",
              name: "ask_user",
              arguments: {
                question: "Send this email?",
                detail: rawDetail,
                options: ["Send it", "Show me first"],
              },
            },
          },
        ],
      });
      const request: AgentRunRequest = {
        runId: "fixture-ask-detail-shape",
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: "Complete fixtures.",
        prompt: "Confirm the draft.",
        history: [],
        model: model.model,
        tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
        secrets: [secret],
        onCheckpoint: async (snapshot) => {
          capture = snapshot;
        },
      };
      try {
        // The authenticated context starts session recording, so the transcript
        // assertions below inspect a real recording, not an empty file list.
        const events = await collect(
          new PiAgentRuntime({ sessionRoot }).run(request, {
            operationId: "ask-shape",
            traceId: "ask-shape",
            spaceId: "fixture-space",
            userId: "fixture-user",
            signal: new AbortController().signal,
          }),
        );
        // The card still asks, without a draft.
        const ask = events.find((event) => event.type === "ask");
        expect(ask).toMatchObject({ text: "Send this email?" });
        expect((ask as { detail?: string } | undefined)?.detail).toBeUndefined();
        // Neither the checkpoint nor the recorded session keeps the raw value.
        expect(capture!()).not.toContain(secret);
        const entries = await readdir(sessionRoot, { recursive: true });
        const transcripts = await Promise.all(
          entries
            .filter((entry) => String(entry).endsWith(".jsonl"))
            .map((entry) => readFile(path.join(sessionRoot, String(entry)), "utf8")),
        );
        expect(transcripts.length).toBeGreaterThan(0);
        expect(transcripts.join("\n")).not.toContain(secret);
        model.assertComplete();
      } finally {
        await model.close();
        await rm(sessionRoot, { recursive: true, force: true });
      }
    },
  );
  it.each([
    ["string", "The token is wrapped-secret-value.", "wrapped-secret-value"],
    ["number", 971334409, "971334409"],
  ])(
    "sanitizes a use_tool-wrapped ask_user detail (%s) before it is kept",
    async (shape, rawDetail, secret) => {
      const sessionRoot = await mkdtemp(path.join(tmpdir(), "rakazo-ask-wrapped-"));
      let capture: (() => string) | undefined;
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "wrapped-question",
              name: "use_tool",
              arguments: {
                name: "ask_user",
                arguments: {
                  question: "Send this email?",
                  detail: rawDetail,
                  options: ["Send it", "Show me first"],
                },
              },
            },
          },
        ],
      });
      const request: AgentRunRequest = {
        runId: "fixture-ask-detail-wrapped",
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: "Complete fixtures.",
        prompt: "Confirm the draft.",
        history: [],
        model: model.model,
        // list_secrets is deferred, so use_tool is listed and can wrap the
        // core ask_user, whose nested arguments the model writes verbatim.
        tools: builtinAgentTools.filter((tool) => ["ask_user", "list_secrets"].includes(tool.name)),
        secrets: [secret],
        onCheckpoint: async (snapshot) => {
          capture = snapshot;
        },
      };
      try {
        const events = await collect(
          new PiAgentRuntime({ sessionRoot }).run(request, {
            operationId: "ask-wrapped",
            traceId: "ask-wrapped",
            spaceId: "fixture-space",
            userId: "fixture-user",
            signal: new AbortController().signal,
          }),
        );
        // The wrapped call still asks, with the sanitized detail.
        const ask = events.find((event) => event.type === "ask");
        expect(ask).toMatchObject({ text: "Send this email?" });
        const detail = (ask as { detail?: string } | undefined)?.detail;
        if (shape === "string") {
          expect(detail).toContain("[redacted]");
        } else {
          expect(detail).toBeUndefined();
        }
        // Neither the checkpoint nor the recorded session keeps the raw value.
        expect(capture!()).not.toContain(secret);
        const entries = await readdir(sessionRoot, { recursive: true });
        const transcripts = await Promise.all(
          entries
            .filter((entry) => String(entry).endsWith(".jsonl"))
            .map((entry) => readFile(path.join(sessionRoot, String(entry)), "utf8")),
        );
        expect(transcripts.length).toBeGreaterThan(0);
        expect(transcripts.join("\n")).not.toContain(secret);
        model.assertComplete();
      } finally {
        await model.close();
        await rm(sessionRoot, { recursive: true, force: true });
      }
    },
  );
  it("resumes from the pending result when the newest stored message is the bot's own reply", async () => {
    let capture: (() => string) | undefined;
    const model = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "question",
            name: "ask_user",
            arguments: { question: "Which fixture?", options: ["One", "Two"] },
          },
        },
        {
          expect(request) {
            // A stored own reply that arrived since the pause is an assistant turn, and a run
            // cannot continue from one, so the request still ends on the pending result.
            expect(request.messages.at(-1)).toMatchObject({
              role: "tool",
              tool_call_id: "question",
            });
            expect(JSON.stringify(request.messages)).not.toContain("Assistant:");
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const request: AgentRunRequest = {
      runId: "fixture-own-reply",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixtures.",
      prompt: "Choose one.",
      history: [],
      model: model.model,
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      onCheckpoint: async (snapshot) => {
        capture = snapshot;
      },
      executeTool: vi.fn(async () => ({ ok: true })),
    };
    try {
      await collect(new PiAgentRuntime().run(request));
      const events = await collect(
        new PiAgentRuntime().run({
          ...request,
          history: [{ id: "own-question", role: "assistant", content: "Which fixture?" }],
          turnCheckpoint: capture!(),
          resumeToolResult: { content: [{ type: "text", text: "Two" }] },
        }),
      );
      expect(events.at(-1)).toEqual({ type: "done", text: "Done." });
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
  it("labels the person's message claimed on resume in a group, and not in a direct chat", async () => {
    for (const group of [true, false]) {
      let capture: (() => string) | undefined;
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "question",
              name: "ask_user",
              arguments: { question: "Which fixture?", options: ["One", "Two"] },
            },
          },
          {
            expect(request) {
              const last = request.messages.at(-1);
              expect(last?.role).toBe("user");
              expect(String(last?.content)).toBe(
                group ? "[User]: Also take two." : "Also take two.",
              );
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      const request: AgentRunRequest = {
        runId: `fixture-resume-steering-${group}`,
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: "Complete fixtures.",
        prompt: "Choose one.",
        history: [],
        model: model.model,
        tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
        onCheckpoint: async (snapshot) => {
          capture = snapshot;
        },
        executeTool: vi.fn(async () => ({ ok: true })),
      };
      try {
        await collect(new PiAgentRuntime().run(request));
        let claimed = false;
        await collect(
          new PiAgentRuntime().run({
            ...request,
            ...(group ? { promptSpeaker: "User" } : {}),
            turnCheckpoint: capture!(),
            resumeToolResult: { content: [{ type: "text", text: "Two" }] },
            claimSteering: async () => {
              if (claimed) return [];
              claimed = true;
              return [{ id: "c1", messageId: "s1", text: "Also take two.", origin: "user" }];
            },
          }),
        );
        model.assertComplete();
      } finally {
        await model.close();
      }
    }
  });
  it.each(["approval", "ask_user", "request_takeover", "request_secret"])(
    "restores earlier evidence and the pending %s result before the first model call",
    async (pause) => {
      const pendingName = pause === "approval" ? "write_file" : pause;
      const args =
        pause === "ask_user"
          ? { question: "Which fixture?", options: ["One", "Two"] }
          : pause === "approval"
            ? { path: "fixture.txt", content: "approved fixture" }
            : pause === "request_secret"
              ? { label: "Fixture code", purpose: "otp" }
              : { reason: "Complete fixture step" };
      let pausedPrefix: ModelEmulatorRequest["messages"] = [];
      const model = await startModelEmulator({
        steps: [
          {
            expect() {},
            response: {
              type: "tool",
              id: "evidence-call",
              name: "read_file",
              arguments: { path: "fixture.txt" },
            },
          },
          {
            expect(request) {
              pausedPrefix = request.messages;
            },
            response: { type: "tool", id: "pending-call", name: pendingName, arguments: args },
          },
          {
            expect(request) {
              expect(request.messages.slice(0, pausedPrefix.length)).toEqual(pausedPrefix);
              const evidence = request.messages.findIndex(
                (message) => message.role === "tool" && message.tool_call_id === "evidence-call",
              );
              expect(evidence).toBeGreaterThan(0);
              expect(JSON.stringify(request.messages[evidence])).toContain(
                "unique-checkpoint-evidence",
              );
              const pending = request.messages.findIndex(
                (message) => message.role === "tool" && message.tool_call_id === "pending-call",
              );
              expect(pending).toBeGreaterThan(evidence);
              expect(JSON.stringify(request.messages[pending])).toContain("fixture-resumed");
              if (pause === "ask_user") {
                const wire = JSON.stringify(request.messages);
                expect(wire).toContain("answer-image.png");
                expect(wire).toContain("data:image/png;base64,AQID");
                expect(wire).toContain("new-thread-text");
                expect(wire.match(/steering-text/g)).toHaveLength(1);
                expect(wire).toContain("data:image/png;base64,BAUG");
              }
            },
            response: { type: "text", text: "Done." },
          },
        ],
      });
      const executions: unknown[] = [];
      let capture: (() => string) | undefined;
      const request: AgentRunRequest = {
        runId: `checkpoint-${pause}`,
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: "Complete the fixture.",
        prompt: "Read the fixture then complete the next step.",
        history: [{ id: "fixture-history", role: "user", content: "Earlier fixture context" }],
        tools: builtinAgentTools.filter((tool) => ["read_file", pendingName].includes(tool.name)),
        model: { ...model.model, acceptsImages: true },
        onCheckpoint: async (snapshot) => {
          capture = snapshot;
        },
        executeTool: async (name, callArgs) => {
          if (name === "read_file") return { evidence: "unique-checkpoint-evidence" };
          executions.push(callArgs);
          return approvalPausedToolResult();
        },
      };
      try {
        await collect(new PiAgentRuntime().run(request));
        expect(capture, "pause must preserve a durable transcript").toBeDefined();
        const checkpoint = capture!();
        executions.length = 0;
        await collect(
          new PiAgentRuntime().run({
            ...request,
            turnCheckpoint: checkpoint,
            ...(pause === "ask_user"
              ? {
                  history: [
                    ...request.history,
                    {
                      id: "answer-message",
                      role: "user" as const,
                      content: "answer-image.png",
                      images: [
                        {
                          name: "answer-image.png",
                          mimeType: "image/png" as const,
                          data: new Uint8Array([1, 2, 3]),
                        },
                      ],
                    },
                    { id: "new-thread-message", role: "user" as const, content: "new-thread-text" },
                    { id: "steering-message", role: "user" as const, content: "steering-text" },
                  ],
                  claimSteering: async (seen: string[]) =>
                    seen.includes("steering")
                      ? []
                      : [
                          {
                            id: "steering",
                            messageId: "steering-message",
                            text: "steering-text",
                            images: [
                              {
                                name: "steering.png",
                                mimeType: "image/png" as const,
                                data: new Uint8Array([4, 5, 6]),
                              },
                            ],
                          },
                        ],
                }
              : {}),
            resumeToolResult: { content: [{ type: "text", text: "fixture-resumed" }] },
            executeTool: async (_name, callArgs) => {
              executions.push(callArgs);
              return { result: "fixture-resumed" };
            },
          } as AgentRunRequest),
        );
        model.assertComplete();
        expect(executions).toEqual(
          pause === "ask_user" || pause === "request_takeover" ? [] : [args],
        );
      } finally {
        await model.close();
        model.assertComplete();
      }
    },
  );
  it("retains completed siblings and never replays an unresolved parallel sibling", async () => {
    const executed = vi.fn(async () => ({ ok: true }));
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            const results = request.messages.filter((message) => message.role === "tool");
            expect(
              results.find((message) => message.tool_call_id === "finished")?.content,
            ).toContain("fixture-evidence");
            expect(
              results.find((message) => message.tool_call_id === "unknown")?.content,
            ).toContain("outcome is unknown");
            expect(results.find((message) => message.tool_call_id === "pending")).toBeDefined();
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const messages = [
      { role: "user", content: "Complete fixtures.", timestamp: 0 },
      {
        role: "assistant",
        content: ["finished", "pending", "unknown"].map((id) => ({
          type: "toolCall",
          id,
          name: "write_file",
          arguments: { path: "fixture.txt", content: id },
        })),
        api: "openai-completions",
        provider: model.model.provider,
        model: model.model.id,
        stopReason: "toolUse",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "finished",
        toolName: "write_file",
        content: [{ type: "text", text: "fixture-evidence" }],
        isError: false,
        timestamp: 0,
      },
    ] as Message[];
    try {
      await collect(
        new PiAgentRuntime().run({
          runId: "fixture-uncertain",
          botId: "fixture-bot",
          threadId: "fixture-thread",
          instructions: "Complete fixtures.",
          prompt: "Continue.",
          history: [],
          model: model.model,
          tools: builtinAgentTools.filter((tool) => tool.name === "write_file"),
          executeTool: executed,
          turnCheckpoint: JSON.stringify({
            version: 1,
            provider: model.model.provider,
            model: model.model.id,
            systemPrompt: "Complete fixtures.",
            pendingToolCallId: "pending",
            executionMode: "parallel",
            messages,
          }),
        }),
      );
      model.assertComplete();
      expect(executed).toHaveBeenCalledExactlyOnceWith(
        "write_file",
        { path: "fixture.txt", content: "pending" },
        expect.any(String),
        undefined,
        expect.any(Object),
      );
    } finally {
      await model.close();
    }
  });
  it("does not answer an unexecuted later interaction with the earlier answer", async () => {
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(
              request.messages
                .filter((message) => message.role === "tool")
                .map((message) => [message.tool_call_id, message.content]),
            ).toEqual([
              ["first-question", "first-answer"],
              ["second-question", "second-answer"],
            ]);
          },
          response: { type: "text", text: "Done." },
        },
      ],
    });
    const messages: Message[] = [
      { role: "user", content: "Choose both fixtures.", timestamp: 0 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "first-question",
            name: "ask_user",
            arguments: { question: "First fixture?", options: ["One", "Two"] },
          },
          {
            type: "toolCall",
            id: "second-question",
            name: "ask_user",
            arguments: { question: "Second fixture?", options: ["Three", "Four"] },
          },
        ],
        api: "openai-completions",
        provider: model.model.provider,
        model: model.model.id,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 0,
      } as Message,
    ];
    let capture: (() => string) | undefined;
    const request: AgentRunRequest = {
      onCheckpoint: async (snapshot) => {
        capture = snapshot;
      },
      runId: "fixture-batch",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: "Complete fixture",
      prompt: "Choose both fixtures.",
      history: [],
      tools: builtinAgentTools.filter((tool) => tool.name === "ask_user"),
      model: model.model,
    };
    const blob = turnCheckpoints.serializeTurnCheckpoint({
      version: 1,
      provider: model.model.provider,
      model: model.model.id,
      systemPrompt: request.instructions,
      pendingToolCallId: "first-question",
      executionMode: "sequential",
      messages,
    });
    try {
      const first = await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: blob,
          resumeToolResult: { content: [{ type: "text", text: "first-answer" }] },
        }),
      );
      expect(model.requests).toHaveLength(0);
      expect(first.filter((event) => event.type === "ask")).toEqual([
        expect.objectContaining({ text: "Second fixture?" }),
      ]);
      expect(capture).toBeDefined();
      const next = capture!();
      await collect(
        new PiAgentRuntime().run({
          ...request,
          turnCheckpoint: next,
          resumeToolResult: { content: [{ type: "text", text: "second-answer" }] },
        }),
      );
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
});
