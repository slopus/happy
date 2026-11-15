import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./openai-compatible-url.js";
import { guardToolCallNames, withoutNamelessToolCalls } from "./pi-tool-call-guard.js";

function toolResult(toolCallId: string, toolName: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 1,
  };
}

const namedCall = {
  type: "toolCall",
  id: "call_named",
  name: "list_tasks",
  arguments: {},
} as const;
const namelessCall = { type: "toolCall", id: "call_nameless", name: "", arguments: {} } as const;

describe("withoutNamelessToolCalls", () => {
  it("drops a tool call without a name together with its result", () => {
    const assistant = fauxAssistantMessage([fauxText("planning"), namedCall, namelessCall]);
    const messages: Message[] = [
      assistant,
      toolResult("call_nameless", ""),
      toolResult("call_named", "list_tasks"),
    ];

    const cleaned = withoutNamelessToolCalls(messages);

    expect(cleaned).toHaveLength(2);
    const [cleanedAssistant, cleanedResult] = cleaned as [AssistantMessage, ToolResultMessage];
    expect(cleanedAssistant.content).toEqual([fauxText("planning"), namedCall]);
    expect(cleanedResult.toolCallId).toBe("call_named");
  });

  it("drops an assistant message that only carried the nameless call", () => {
    const assistant = fauxAssistantMessage(namelessCall);

    expect(withoutNamelessToolCalls([assistant])).toEqual([]);
  });

  it("recovers a missing result name from its named call and keeps the content", () => {
    const assistant = fauxAssistantMessage(namedCall);
    const messages: Message[] = [assistant, toolResult("call_named", "  ")];

    expect(withoutNamelessToolCalls(messages)).toEqual([
      assistant,
      { ...messages[1], toolName: "list_tasks" },
    ]);
  });

  it("drops a nameless result without a matching named call", () => {
    expect(withoutNamelessToolCalls([toolResult("call_missing", "")])).toEqual([]);
  });

  it("drops a named result whose call was removed from the transcript", () => {
    const messages: Message[] = [
      fauxAssistantMessage([fauxText("planning"), namelessCall]),
      toolResult("call_nameless", "list_tasks"),
    ];

    expect(withoutNamelessToolCalls(messages).map((message) => message.role)).toEqual([
      "assistant",
    ]);
  });

  it("handles legacy null assistant content while sanitizing a transcript", () => {
    const assistant = { ...fauxAssistantMessage(""), content: null } as unknown as AssistantMessage;

    expect(withoutNamelessToolCalls([assistant, fauxAssistantMessage(namelessCall)])).toEqual([
      { ...assistant, content: [] },
    ]);
  });

  it("keeps a transcript without tool calls untouched", () => {
    const messages: Message[] = [{ role: "user", content: "hallo", timestamp: 1 }];

    expect(withoutNamelessToolCalls(messages)).toEqual(messages);
  });
});

describe("guardToolCallNames", () => {
  it("sanitizes the transcript handed to the provider and passes a clean one through", async () => {
    const models = createModels();
    const faux = fauxProvider({ provider: OPENAI_COMPATIBLE_PROVIDER_ID });
    models.setProvider(faux.provider);
    expect(guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID)).toBe(models);

    const seen: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("done");
      },
    ]);

    const provider = models.getProvider(faux.provider.id);
    expect(provider).toBeDefined();
    const model = faux.models[0];

    const dirty = normalizeContext({
      messages: [
        fauxAssistantMessage([fauxText("planning"), namelessCall]),
        toolResult("call_nameless", ""),
      ],
    });
    dirty.messages.unshift({
      ...fauxAssistantMessage(""),
      content: null,
    } as unknown as AssistantMessage);
    const result = await provider!.streamSimple(model, dirty).result();

    expect(result.content).toEqual([fauxText("done")]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages).toHaveLength(2);
    expect(seen[0]!.messages[0]).toMatchObject({ role: "assistant" });
    expect(seen[0]).not.toBe(dirty);
  });

  it("does not re-wrap providers and leaves a clean transcript by reference", async () => {
    const models = createModels();
    const faux = fauxProvider({ provider: OPENAI_COMPATIBLE_PROVIDER_ID });
    models.setProvider(faux.provider);

    guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
    const once = models.getProvider(faux.provider.id);
    guardToolCallNames(models, OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(models.getProvider(faux.provider.id)).toBe(once);

    const seen: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        seen.push(context);
        return fauxAssistantMessage("done");
      },
    ]);

    const clean = normalizeContext({
      messages: [{ role: "user", content: "hallo", timestamp: 1 }],
    });
    await once!.streamSimple(faux.models[0], clean).result();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(clean);
  });
});
