import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createRuntimeContextPolicy } from "./runtime-context.js";
import { restoreTurnCheckpoint, serializeTurnCheckpoint } from "./turn-checkpoint.js";

const assistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "synthetic thought", thinkingSignature: "fixture-signature" },
    { type: "toolCall", id: "pending", name: "write_file", arguments: {} },
  ],
  api: "openai-completions",
  provider: "fixture",
  model: "first",
  stopReason: "toolUse",
  timestamp: 0,
} as Message;
const checkpoint = {
  version: 1 as const,
  provider: "fixture",
  model: "first",
  systemPrompt: "Stable system",
  pendingToolCallId: "pending",
  messages: [{ role: "user", content: "Fixture request", timestamp: 0 } as Message, assistant],
};

describe("turn checkpoint", () => {
  it("round trips deterministically and preserves its original prefix", () => {
    const blob = serializeTurnCheckpoint(checkpoint);
    const first = restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" });
    expect(first).toEqual(checkpoint);
    expect(JSON.stringify(first)).toBe(
      JSON.stringify(restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" })),
    );
  });
  it("drops the aborted assistant tail while retaining the pending call", () => {
    const tail = { ...assistant, content: [], stopReason: "aborted" } as Message;
    expect(
      restoreTurnCheckpoint(
        serializeTurnCheckpoint({ ...checkpoint, messages: [...checkpoint.messages, tail] }),
        { provider: "fixture", id: "first" },
      ).messages,
    ).toEqual(checkpoint.messages);
  });
  it("strips thinking when the model changes", () => {
    const restored = restoreTurnCheckpoint(serializeTurnCheckpoint(checkpoint), {
      provider: "fixture",
      id: "second",
    });
    expect(JSON.stringify(restored.messages)).not.toContain("synthetic thought");
    expect(JSON.stringify(restored.messages)).toContain("pending");
  });
  it.each(["retrieval", "current"] as const)(
    "restored results use the same newest-first budget and remain shortened on rebuild (%s)",
    (strategy) => {
      const messages: Message[] = [checkpoint.messages[0]!];
      for (let index = 0; index < 14; index++) {
        messages.push(
          {
            ...assistant,
            content: [
              {
                type: "toolCall",
                id: `page-${index}`,
                name: "connectors_execute_tool",
                arguments: {},
              },
            ],
          } as Message,
          {
            role: "toolResult",
            toolCallId: `page-${index}`,
            toolName: "connectors_execute_tool",
            content: [{ type: "text", text: `Page ${index} ${"0".repeat(9500)}` }],
            timestamp: index,
            isError: false,
          },
        );
      }
      messages.push(assistant, {
        role: "toolResult",
        toolCallId: "pending",
        toolName: "write_file",
        content: [{ type: "text", text: "done" }],
        timestamp: 0,
        isError: false,
      });
      const restored = restoreTurnCheckpoint(serializeTurnCheckpoint({ ...checkpoint, messages }), {
        provider: "fixture",
        id: "first",
      });
      const request = {
        runId: "fixture-run",
        botId: "fixture-bot",
        threadId: "fixture-thread",
        instructions: restored.systemPrompt,
        prompt: "Fixture request",
        tools: [],
        history: [],
        contextStrategy: strategy,
        turnCheckpoint: serializeTurnCheckpoint({ ...checkpoint, messages }),
        model: { provider: "fixture", id: "first" },
      } as AgentRunRequest;
      const policy = createRuntimeContextPolicy(request);
      const model = {
        provider: "fixture",
        id: "first",
        contextWindow: 80_000,
        maxTokens: 4096,
      } as Model<Api>;
      const prepared = policy.prepareContext(
        { systemPrompt: restored.systemPrompt, messages: restored.messages, tools: [] },
        model,
      );
      const results = prepared.messages.filter(
        (message) =>
          message.role === "toolResult" && message.toolName === "connectors_execute_tool",
      );
      expect(results).toHaveLength(14);
      const whole = results.map((message) => JSON.stringify(message.content).length > 9000);
      expect(whole.indexOf(true)).toBeGreaterThan(0);
      expect(whole).toEqual(whole.map((_, index) => index >= whole.indexOf(true)));
      expect(policy.getDecision()!.estimatedInputTokens).toBeLessThanOrEqual(80_000 - 4096);
      const rebuilt = policy.prepareContext(
        { systemPrompt: "Changed system", messages: restored.messages, tools: [] },
        { ...model, contextWindow: 200_000 },
      );
      for (const result of results) {
        if (result.role !== "toolResult" || JSON.stringify(result.content).length >= 9000) continue;
        expect(
          rebuilt.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === result.toolCallId,
          ),
        ).toEqual(result);
      }
    },
  );
  it("prunes restored stale screenshots through the existing context policy", () => {
    const messages: Message[] = [checkpoint.messages[0]!];
    for (let index = 0; index < 3; index++) {
      messages.push(
        {
          ...assistant,
          content: [
            { type: "toolCall", id: `shot-${index}`, name: "computer_observe", arguments: {} },
          ],
        } as Message,
        {
          role: "toolResult",
          toolCallId: `shot-${index}`,
          toolName: "computer_observe",
          details: { frameId: `frame-${index}` },
          content: [{ type: "image", data: "fixture-image", mimeType: "image/png" }],
          timestamp: index,
          isError: false,
        },
      );
    }
    const blob = serializeTurnCheckpoint({ ...checkpoint, messages });
    const restored = restoreTurnCheckpoint(blob, { provider: "fixture", id: "first" });
    const request = {
      runId: "fixture-run",
      botId: "fixture-bot",
      threadId: "fixture-thread",
      instructions: restored.systemPrompt,
      prompt: "Fixture request",
      tools: [],
      history: [],
      turnCheckpoint: blob,
      model: { provider: "fixture", id: "first", maxImagesPerPrompt: 1 },
    } as AgentRunRequest;
    const prepared = createRuntimeContextPolicy(request).prepareContext(
      { systemPrompt: restored.systemPrompt, messages: restored.messages, tools: [] },
      { provider: "fixture", id: "first", contextWindow: 80_000, maxTokens: 4096 } as Model<Api>,
    );
    const screenshots = prepared.messages.filter(
      (message) =>
        message.role === "toolResult" && message.content.some((part) => part.type === "image"),
    );
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).toMatchObject({ toolCallId: "shot-2" });
  });
});
