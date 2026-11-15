import { MODEL_CONTEXT_TOO_SMALL_ERROR, VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  ContextCacheTracker,
  estimateContextTokens,
  estimateTextTokens,
  providerContextPrefix,
  selectContext,
  shortenToolResultText,
} from "./context-selection.js";

const budget = {
  contextWindow: 2000,
  outputReserve: 200,
  systemPrompt: "Stable instructions",
  tools: [],
};
const user = (content: string) => ({ role: "user", content, timestamp: 1 });
describe("bounded context selection", () => {
  it("tells a model too small for the instructions and tools apart from a long conversation", () => {
    const tools = [{ name: "search", description: "Search ".repeat(1200), parameters: {} }];
    expect(() =>
      selectContext([user("hi")], { budget: { ...budget, tools }, strategy: "current" }),
    ).toThrow(MODEL_CONTEXT_TOO_SMALL_ERROR);
    expect(() =>
      selectContext([user("long ".repeat(2000))], { budget, strategy: "current" }),
    ).toThrow("Required context exceeds the model context budget");
  });
  it("accounts for instructions, tools, images and output reserve", () => {
    expect(estimateContextTokens([{ type: "image", data: "base64" }], 1000)).toBeGreaterThan(1000);
    const selected = selectContext([user("current")], { budget, strategy: "retrieval" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(selected.estimatedInputTokens).toBeGreaterThan(estimateContextTokens(user("current")));
  });
  it("counts mandatory system-message context before trying to shorten conversation history", () => {
    const messages = [{ role: "system", content: "x".repeat(10_000) }, user("A short request")];
    expect(() => selectContext(messages, { budget, strategy: "retrieval" })).toThrow(
      MODEL_CONTEXT_TOO_SMALL_ERROR,
    );
    expect(messages).toEqual([
      { role: "system", content: "x".repeat(10_000) },
      user("A short request"),
    ]);
  });
  it("does not budget unknown images as zero or count local-only Pi metadata", () => {
    const image = {
      role: "user",
      content: [{ type: "image", data: "a".repeat(10000), mimeType: "image/png" }],
    };
    expect(() => selectContext([image], { budget, strategy: "retrieval" })).toThrow(
      ContextBudgetError,
    );
    expect(
      selectContext([image], { budget: { ...budget, imageTokens: 100 }, strategy: "retrieval" })
        .messages,
    ).toHaveLength(1);
    const decorated = { ...user("request"), privateSessionMetadata: "ignored ".repeat(10000) };
    expect(selectContext([decorated], { budget, strategy: "retrieval" }).estimatedInputTokens).toBe(
      selectContext([user("request")], { budget, strategy: "retrieval" }).estimatedInputTokens,
    );
  });
  it("never substitutes an image estimate for image-shaped tool arguments", () => {
    const args = { type: "image", mimeType: "image/png", data: "a".repeat(10000) };
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "upload", arguments: args }],
    };
    expect(estimateContextTokens(assistant, 100)).toBe(estimateContextTokens(assistant));
    expect(estimateContextTokens(assistant, 100)).toBeGreaterThan(3000);
  });
  it("shortens every result in an indirectly protected tool group and rejects duplicate results", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
    };
    const result = { role: "toolResult", toolCallId: "call", content: "huge ".repeat(10000) };
    const selected = selectContext([call, result, user("steering")], {
      budget,
      strategy: "retrieval",
      protectedIndexes: [0],
    });
    expect(selected.messages).toHaveLength(3);
    expect(selected.truncatedToolResults).toBe(1);
    expect(() =>
      selectContext([call, result, result, user("steering")], { budget, strategy: "retrieval" }),
    ).toThrow("Duplicate tool result");
  });
  it("keeps an opted-in MCP result whole and fails when that result cannot fit", () => {
    const link = "https://sessions.example.test/join/abc";
    const body = `${"before ".repeat(800)}${link}${" after".repeat(800)}`;
    const call = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call",
          name: "connectors_execute_tool",
          arguments: { id: "srv_mail:get_message" },
        },
      ],
    };
    const result = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "connectors_execute_tool",
      content: body,
    };
    const options = {
      budget,
      strategy: "retrieval" as const,
      protectedIndexes: [0],
      verbatimMcpServers: { ids: ["srv_mail"], slugs: ["mail"] },
    };
    expect(() => selectContext([call, result, user("steering")], options)).toThrow(
      VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
    );
    expect(result.content).toContain(link);
    const fitting = selectContext([call, result, user("steering")], {
      ...options,
      budget: { ...budget, contextWindow: 20_000 },
    });
    expect(JSON.stringify(fitting.messages)).toContain(link);
    expect(JSON.stringify(fitting.messages)).not.toContain("Tool result truncated");
  });
  it("blames a whole MCP result only when shortening it would make the turn fit", () => {
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "mcp__mail__get_message", arguments: {} }],
    };
    const result = { role: "toolResult", toolCallId: "call", content: "x ".repeat(2_000) };
    const huge = user("y ".repeat(20_000));
    expect(() =>
      selectContext([call, result, huge], {
        budget,
        strategy: "retrieval",
        protectedIndexes: [0, 2],
        verbatimMcpServers: { ids: [], slugs: ["mail"] },
      }),
    ).toThrow("Required context exceeds the model context budget");
  });
  it("keeps and shortens the unread tool step after steering", () => {
    const oldCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }],
    };
    const oldResult = { role: "toolResult", toolCallId: "old", content: "old ".repeat(2000) };
    const current = user("current objective");
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "pending", name: "read", arguments: {} }],
    };
    const result = { role: "toolResult", toolCallId: "pending", content: "x".repeat(6000) };
    const steering = user("also check the summary");
    const selected = selectContext([oldCall, oldResult, current, call, result, steering], {
      budget,
      strategy: "retrieval",
      protectedIndexes: [2, 5],
    });
    expect(selected.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(selected.messages[1]).toEqual(call);
    expect(selected.messages[2]).toMatchObject({ toolCallId: "pending" });
    expect(JSON.stringify(selected.messages[2]!.content)).toContain("Tool result truncated");
    expect(selected.truncatedToolResults).toBe(1);
    expect(selected.droppedMessages).toBe(2);
    expect(selected.estimatedInputTokens).toBeLessThanOrEqual(
      budget.contextWindow - budget.outputReserve,
    );
  });
  it("preserves actual images while shortening result text and fails if the image alone cannot fit", () => {
    const image = { type: "image", data: "a".repeat(10000), mimeType: "image/png" };
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "capture", arguments: {} }],
    };
    const result = {
      role: "toolResult",
      toolCallId: "call",
      content: [image, { type: "text", text: "large text ".repeat(10000) }],
    };
    expect(() =>
      selectContext([user("objective"), call, result], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    const selected = selectContext([user("objective"), call, result], {
      budget: { ...budget, imageTokens: 100 },
      strategy: "retrieval",
    });
    expect(JSON.stringify(selected.messages.at(-1)!.content)).toContain(image.data);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("drops older exchanges while retaining current input and durable protected constraints", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    const selected = selectContext(history, {
      budget,
      strategy: "snapshots",
      recentExchanges: 2,
      protectedIndexes: [0],
    });
    expect(selected.messages).toEqual([history[0], history[18], history[19]]);
    expect(selected.droppedMessages).toBe(17);
  });
  it("keeps exchanges older than the recent ones while they fit the token allowance", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    const select = (tokens?: number, protectedIndexes: number[] = []) =>
      selectContext(history, {
        budget,
        strategy: "retrieval",
        recentExchanges: 2,
        protectedIndexes,
        ...(tokens === undefined ? {} : { earlier: { before: 19, tokens } }),
      }).messages;
    expect(select()).toEqual(history.slice(18));
    const some = select(200);
    expect(some.length).toBeGreaterThan(2);
    expect(some.length).toBeLessThan(20);
    expect(some).toEqual(history.slice(-some.length));
    expect(select(100_000)).toEqual(history);
    // A protected summary at the start is not where the current request starts.
    expect(select(100_000, [0])).toEqual(history);
  });
  it("retains a warm useful prefix when budget allows, cold selection performs no summary work", () => {
    const history = Array.from({ length: 20 }, (_, index) => user(`exchange ${index}`));
    expect(
      selectContext(history, { budget, strategy: "cache-aware", cacheWarmth: "likely-warm" })
        .messages,
    ).toHaveLength(20);
    expect(
      selectContext(history, {
        budget,
        strategy: "cache-aware",
        cacheWarmth: "likely-cold",
        recentExchanges: 2,
      }).messages,
    ).toHaveLength(2);
  });
  it("drops old tool groups together during long loops", () => {
    const history = [
      user("current objective"),
      ...Array.from({ length: 40 }, (_, index) => [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: `tool-${index}`, name: "read", arguments: {} }],
        },
        { role: "toolResult", toolCallId: `tool-${index}`, content: "result ".repeat(30) },
      ]).flat(),
    ];
    const result = selectContext(history, { budget, strategy: "retrieval" });
    expect(result.messages[0]).toEqual(history[0]);
    expect(result.messages.at(-1)).toEqual(history.at(-1));
    expect(result.droppedMessages).toBeGreaterThan(0);
    for (let index = 1; index < result.messages.length; index += 2) {
      expect(result.messages[index]!.role).toBe("assistant");
      expect(result.messages[index + 1]!.role).toBe("toolResult");
    }
  });
  it("shortens an oversized latest tool result without corrupting tool references", () => {
    const history = [
      user("objective"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        content: [{ type: "text", text: "large data ".repeat(10000) }],
      },
    ];
    const selected = selectContext(history, { budget, strategy: "retrieval" });
    expect(selected.truncatedToolResults).toBeGreaterThan(0);
    expect(selected.messages[1]).toEqual(history[1]);
    expect(selected.messages[2]).toMatchObject({ toolCallId: "call" });
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
    expect(JSON.stringify(selected.messages[2]!.content)).toContain("Tool result truncated");
  });
  it("keeps read and unread markers distinct when protected results exceed the budget", () => {
    const call = (id: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    });
    const result = (id: string, content: string) => ({
      role: "toolResult",
      toolCallId: id,
      content,
    });
    for (const readSource of [
      JSON.stringify({ body: "r".repeat(900) }),
      shortenToolResultText(
        JSON.stringify({ body: "r".repeat(5000) }),
        1024,
        {},
        { afterUse: true },
      ),
    ]) {
      const selected = selectContext(
        [
          user("objective"),
          call("read"),
          result("read", readSource),
          call("unread"),
          result("unread", JSON.stringify({ body: "u".repeat(5000) })),
        ],
        { budget, strategy: "retrieval", protectedIndexes: [1] },
      );
      const read = JSON.stringify(selected.messages[2]!.content);
      const unread = JSON.stringify(selected.messages[4]!.content);
      expect(read.length).toBeLessThan(JSON.stringify(readSource).length);
      expect(read).toContain("Earlier result shortened after you read it");
      expect(read).not.toContain("unavailable");
      expect(unread).toContain("omitted evidence is unavailable");
      expect(unread).not.toContain("Earlier result shortened");
    }
  });
  it("shortens a large connector result without stalling", () => {
    const messages = Array.from({ length: 1000 }, (_, index) => ({
      messageId: `m${index}`,
      subject: `subject ${index} `.repeat(20),
      messageText: `body ${index} `.repeat(400),
    }));
    const startedAt = performance.now();
    const shortened = shortenToolResultText(JSON.stringify({ data: { messages } }), 12_000);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    const parsed = JSON.parse(shortened);
    expect(parsed.data.messages).toHaveLength(1000);
    expect(parsed.data.messages[999].messageId).toBe("m999");
    expect(parsed.data.messages[0].messageText).toContain("omitted evidence is unavailable");
  });
  it("marks a protected result as read when an assistant reply follows it", () => {
    const selected = selectContext(
      [
        user("objective"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "read", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "read",
          content: JSON.stringify({ body: "r".repeat(10_000) }),
        },
        { role: "assistant", content: [{ type: "text", text: "Summary of the file." }] },
        user("next"),
      ],
      { budget, strategy: "retrieval", protectedIndexes: [1] },
    );
    const read = JSON.stringify(selected.messages[2]!.content);
    expect(read).toContain("Earlier result shortened after you read it");
    expect(read).not.toContain("unavailable");
  });
  it("keeps history snapshot topic and outcome within whole Unicode characters", () => {
    const payload = {
      untrusted: true,
      messages: [],
      snapshots: [{ topic: `${"a".repeat(79)}😀tail`, outcome: `${"b".repeat(79)}😀tail` }],
    };
    const result = JSON.parse(
      shortenToolResultText(JSON.stringify(payload), 1000, { name: "read_history" }),
    );
    expect(result.snapshots[0].topic).toBe("a".repeat(79));
    expect(result.snapshots[0].outcome).toBe("b".repeat(79));
  });
  it("keeps history reference truncation and continuation on a Unicode boundary", () => {
    const ref = { text: "aaa😀bbb", textOffset: 7, nextTextOffset: null, truncated: false };
    for (const payload of [
      { untrusted: true, messages: [ref], runs: [] },
      { untrusted: true, messages: [], runs: [{ outcomes: [ref] }] },
    ]) {
      const size = JSON.stringify({ ...payload, contextTruncated: true }).length - 1;
      const result = JSON.parse(
        shortenToolResultText(JSON.stringify(payload), size, { name: "read_history" }),
      );
      const shortened = result.messages[0] ?? result.runs[0].outcomes[0];
      expect(shortened.text).toBe("aaa");
      expect(shortened.nextTextOffset).toBe(10);
      expect(shortened.truncated).toBe(true);
    }
  });
  it("shortens another reference when a single emoji cannot be shortened", () => {
    const ref = (text: string) => ({ text, textOffset: 4, nextTextOffset: null, truncated: false });
    const payload = { untrusted: true, messages: [ref("😀"), ref("ab")] };
    const size = JSON.stringify({ ...payload, contextTruncated: true }).length - 1;
    const result = JSON.parse(
      shortenToolResultText(JSON.stringify(payload), size, { name: "search_history" }),
    );
    expect(result.messages[0].text).toBe("😀");
    expect(result.messages[1]).toMatchObject({ text: "a", nextTextOffset: 5, truncated: true });
  });
  it("can shorten an emoji followed by another character and retries if nothing can shrink", () => {
    const ref = { text: "😀a", textOffset: 4, nextTextOffset: null, truncated: false };
    const payload = { untrusted: true, messages: [ref] };
    const size = JSON.stringify({ ...payload, contextTruncated: true }).length - 1;
    const result = JSON.parse(
      shortenToolResultText(JSON.stringify(payload), size, { name: "read_history" }),
    );
    expect(result.messages[0]).toMatchObject({ text: "😀", nextTextOffset: 6, truncated: true });
    const retry = JSON.parse(
      shortenToolResultText(JSON.stringify(payload), 1, {
        name: "read_history",
        arguments: { messageId: "example" },
      }),
    );
    expect(retry).toMatchObject({
      untrusted: true,
      contextTruncated: true,
      needsRetry: true,
      retry: { messageId: "example", limit: 1 },
    });
  });
  it("shortens history JSON evidence while preserving exact original offsets and pagination", () => {
    const original = 'Quoted "value" and newline\n'.repeat(500);
    const payload = {
      untrusted: true,
      messages: [
        {
          messageId: "anchor",
          text: original.slice(250, 5000),
          textOffset: 250,
          nextTextOffset: 5000,
          truncated: true,
        },
      ],
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
      runs: [],
      snapshots: [],
    };
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [{ type: "text", text: JSON.stringify(payload) }],
        },
      ],
      { budget: { ...budget, contextWindow: 1500 }, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      nextRunId: "run-cursor",
      nextArtifactId: "artifact-cursor",
      nextOutcomeSeq: 90,
    });
    expect(decoded.messages[0].nextTextOffset).toBe(250 + decoded.messages[0].text.length);
    expect(decoded.messages[0].text).toBe(original.slice(250, decoded.messages[0].nextTextOffset));
    expect(decoded.messages[0].truncated).toBe(true);
    expect(selected.truncatedToolResults).toBe(1);
  });
  it("returns valid retry JSON when history navigation metadata cannot fit", () => {
    const selected = selectContext(
      [
        user("Read original evidence"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "history",
              name: "read_history",
              arguments: { messageId: "anchor" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "history",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                untrusted: true,
                messages: Array.from({ length: 100 }, (_, index) => ({
                  messageId: `anchor-${index}`,
                  text: "x",
                  textOffset: 0,
                })),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      untrusted: true,
      needsRetry: true,
      retry: { messageId: "anchor", limit: 1 },
    });
  });
  it("preserves generic JSON controls and marks omitted diagnostic strings", () => {
    const selected = selectContext(
      [
        user("Read diagnostics"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "diagnostic", name: "read_diagnostic", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "diagnostic",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                nextCursor: "segment-2",
                segment: 1,
                approval: "pending",
                diagnostic: 'quoted "value"\n'.repeat(3000),
              }),
            },
          ],
        },
      ],
      { budget, strategy: "retrieval" },
    );
    const content = selected.messages.at(-1)!.content as Array<{ text: string }>;
    const decoded = JSON.parse(content[0]!.text);
    expect(decoded).toMatchObject({
      nextCursor: "segment-2",
      segment: 1,
      approval: "pending",
      contextTruncated: true,
    });
    expect(decoded.diagnostic).toContain("Tool result truncated");
  });
  it("keeps every id inside an MCP text envelope when shortening its JSON", () => {
    const names = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hal", "Ivy"];
    const inner = JSON.stringify({
      date: "2026-10-12",
      time_zone: "UTC",
      conversations: names.map((name, index) => ({
        conversation_id: `conv${String(index).padStart(4, "0")}example`,
        kind: "bot",
        name,
        messages: index * 7 + 2,
      })),
      note: "context ".repeat(200),
    });
    const source = JSON.stringify({ content: [{ type: "text", text: inner }] });
    const out = shortenToolResultText(source, 1024, { name: "connectors_execute_tool" });
    // Protected ids/names may exceed the soft target; they must never be cut to meet it.
    expect(out.length).toBeLessThan(source.length / 2);
    const envelope = JSON.parse(out);
    expect(envelope.contextTruncated).toBe(true);
    const decoded = JSON.parse(envelope.content[0].text);
    expect(decoded.contextTruncated).toBe(true);
    expect(decoded.conversations.map((c: { name: string }) => c.name)).toEqual(names);
    for (const [index, c] of decoded.conversations.entries())
      expect(c.conversation_id).toBe(`conv${String(index).padStart(4, "0")}example`);
    expect(decoded.note).toContain("Tool result truncated");
  });
  it("keeps an MCP JSON array of only ids and names whole instead of cutting it", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: `conversation-${index}`,
      name: `Conversation ${index}`,
    }));
    const source = JSON.stringify({ content: [{ type: "text", text: JSON.stringify(rows) }] });
    const out = shortenToolResultText(source, 1024);
    const envelope = JSON.parse(out);
    expect(JSON.parse(envelope.content[0].text)).toEqual(rows);
  });
  it("shortens both copies of an MCP result while preserving ids, names and cursors", () => {
    const conversations = Array.from({ length: 9 }, (_, index) => ({
      id: `conversation-${index}`,
      name: `Conversation ${index}`,
      description: "bulky prose ".repeat(1000),
    }));
    const inner = { conversations, nextCursor: "next-page", note: "details ".repeat(1000) };
    const source = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(inner) }],
      structuredContent: inner,
      isError: false,
    });
    const out = shortenToolResultText(source, 1024);
    const envelope = JSON.parse(out);
    expect(envelope.contextTruncated).toBe(true);
    expect(envelope.isError).toBe(false);
    expect(out.length).toBeLessThan(source.length / 10);
    for (const copy of [JSON.parse(envelope.content[0].text), envelope.structuredContent]) {
      expect(copy.nextCursor).toBe(inner.nextCursor);
      expect(
        copy.conversations.map(({ id, name }: { id: string; name: string }) => ({ id, name })),
      ).toEqual(conversations.map(({ id, name }) => ({ id, name })));
      expect(copy.note.length).toBeLessThan(200);
      for (const conversation of copy.conversations) {
        expect(conversation.description.length).toBeLessThan(200);
        expect(conversation.description).toContain("Tool result truncated");
      }
    }
  });
  it("does not mark an MCP envelope truncated when both copies already fit", () => {
    const inner = { id: "conversation-1", name: "Conversation", note: "brief" };
    const envelope = {
      content: [{ type: "text", text: JSON.stringify(inner) }],
      structuredContent: inner,
    };
    const out = shortenToolResultText(JSON.stringify(envelope), 1024);
    expect(JSON.parse(out)).toEqual(envelope);
    expect(JSON.parse(out).contextTruncated).toBeUndefined();
  });
  it("shortens large MCP outer metadata without cutting routing fields or inner JSON", () => {
    const inner = { id: "conversation-1", name: "Conversation", nextCursor: "next-page" };
    const controls = {
      id: "metadata-1",
      name: "Metadata",
      nextCursor: "metadata-page",
      url: `https://example.com/${"route/".repeat(30)}`,
      path: `/${"folder/".repeat(30)}`,
      status: "success",
      type: "result",
    };
    const source = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(inner) }],
      _meta: { ...controls, description: "bulky metadata ".repeat(3000) },
    });
    const out = shortenToolResultText(source, 1024);
    const envelope = JSON.parse(out);
    expect(envelope.contextTruncated).toBe(true);
    expect(JSON.parse(envelope.content[0].text)).toMatchObject(inner);
    expect(envelope._meta).toMatchObject(controls);
    expect(envelope._meta.description.length).toBeLessThan(200);
    expect(out.length).toBeLessThan(1024);
  });
  it("shortens a large sibling prose part so the envelope still fits", () => {
    const inner = JSON.stringify({
      id: "conv-1",
      name: "Ada",
      note: "keep ".repeat(50),
    });
    const source = JSON.stringify({
      content: [
        { type: "text", text: inner },
        { type: "text", text: "summary ".repeat(5000) },
      ],
    });
    const out = shortenToolResultText(source, 1024);
    expect(out.length).toBeLessThan(source.length / 5);
    const envelope = JSON.parse(out);
    expect(envelope.contextTruncated).toBe(true);
    const decoded = JSON.parse(envelope.content[0].text);
    expect(decoded.id).toBe("conv-1");
    expect(decoded.name).toBe("Ada");
    expect(envelope.content[1].text.length).toBeLessThan(2000);
  });
  it("leaves non-JSON MCP text to the generic shortener", () => {
    const source = JSON.stringify({ content: [{ type: "text", text: "plain ".repeat(1000) }] });
    const out = shortenToolResultText(source, 512);
    expect(out.length).toBeLessThan(source.length);
  });
  it("marks results shortened after use as read, not unavailable", () => {
    const sources = [
      "file line ".repeat(1500),
      JSON.stringify({ id: "doc-1", body: "config value ".repeat(1000) }),
      JSON.stringify({
        content: [
          { type: "text", text: JSON.stringify({ id: "doc-1", body: "row ".repeat(2000) }) },
        ],
      }),
    ];
    for (const source of sources) {
      const before = shortenToolResultText(source, 1024);
      expect(before).toMatch(/omitted evidence is unavailable|inspect original evidence/);
      const after = shortenToolResultText(source, 1024, {}, { afterUse: true });
      expect(after).toContain("Earlier result shortened after you read it");
      expect(after).toContain("statements made from it stand");
      expect(after).not.toContain("unavailable");
      expect(after).not.toContain("inspect original evidence");
      expect(after.length).toBeLessThan(source.length / 4);
      expect(shortenToolResultText(source, 1024, {}, { afterUse: true })).toBe(after);
    }
  });
  it("preserves an existing after-use marker when shortened again without options", () => {
    const source = shortenToolResultText(
      JSON.stringify({ body: "evidence ".repeat(1000) }),
      1024,
      {},
      { afterUse: true },
    );
    const out = shortenToolResultText(source, 256);
    expect(out.length).toBeLessThan(source.length);
    expect(out).toContain("Earlier result shortened after you read it");
    expect(out).not.toContain("unavailable");
  });
  it("shrinks medium-length fields when shortening after use", () => {
    const source = JSON.stringify({
      id: "doc-1",
      fields: Array.from({ length: 7 }, (_, index) => `${index} ${"evidence ".repeat(24)}`),
    });
    const out = shortenToolResultText(source, 1024, {}, { afterUse: true });
    expect(out.length).toBeLessThan(source.length);
    expect(out).toContain("Earlier result shortened after you read it");
    expect(JSON.parse(out).id).toBe("doc-1");
  });
  it("keeps ids in a JSON text part when the MCP envelope also has other content", () => {
    const names = ["Ada", "Ben", "Cleo"];
    const inner = JSON.stringify({
      conversations: names.map((name, index) => ({
        conversation_id: `conv${index}`,
        name,
        blurb: "padding ".repeat(400),
      })),
    });
    const source = JSON.stringify({
      content: [
        { type: "text", text: inner },
        { type: "resource_link", uri: "mcp://example/conv", name: "conversations" },
      ],
    });
    const out = shortenToolResultText(source, 1024);
    const envelope = JSON.parse(out);
    expect(envelope.contextTruncated).toBe(true);
    expect(envelope.content).toHaveLength(2);
    expect(envelope.content[1]).toEqual({
      type: "resource_link",
      uri: "mcp://example/conv",
      name: "conversations",
    });
    const decoded = JSON.parse(envelope.content[0].text);
    expect(decoded.conversations.map((c: { name: string }) => c.name)).toEqual(names);
    for (const [index, c] of decoded.conversations.entries())
      expect(c.conversation_id).toBe(`conv${index}`);
  });
  it("fails explicitly if mandatory content cannot fit rather than silently losing the request", () => {
    expect(() =>
      selectContext([user("large ".repeat(2000))], { budget, strategy: "retrieval" }),
    ).toThrow(ContextBudgetError);
    expect(() =>
      selectContext([{ role: "toolResult", content: "orphan" }], { budget, strategy: "current" }),
    ).toThrow("Orphaned");
  });
});
describe("cache request metadata", () => {
  const request = {
    accountScope: "synthetic-account",
    connectionId: "connection",
    modelId: "model",
    prefix: providerContextPrefix("stable", [], [user("first")]),
    prefixTokens: 2000,
    capabilities: { scope: "account" as const, retentionMs: 300000, minimumTokens: 1000 },
  };
  it("predicts timing with fake clock and matching appended prefixes", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    expect(tracker.predict(request)).toBe("likely-cold");
    tracker.record(request, 1000);
    time = 10000;
    expect(
      tracker.predict({
        ...request,
        prefix: providerContextPrefix("stable", [], [user("first"), user("next")]),
      }),
    ).toBe("likely-warm");
    time = 300000;
    expect(tracker.predict(request)).toBe("likely-cold");
  });
  it("uses request-start time even when completion arrives after retention expires", () => {
    let time = 0;
    const tracker = new ContextCacheTracker(() => time);
    const started = tracker.stamp(request);
    time = 300001;
    tracker.record(started, 1000);
    expect(tracker.predict(request)).toBe("likely-cold");
    const next = tracker.stamp(request);
    time += 100;
    tracker.record(next, 1000);
    expect(tracker.predict({ ...request, startedAt: -99999 })).toBe("likely-warm");
    // A late completion from an older request cannot replace the newer start time.
    tracker.record(started, 0);
    expect(tracker.predict(request)).toBe("likely-warm");
  });
  it("does not retain a warm prediction when caching is explicitly disabled", () => {
    const tracker = new ContextCacheTracker(() => 0);
    const disabled = {
      ...request,
      capabilities: { ...request.capabilities, retentionMode: "none" as const },
    };
    tracker.record(disabled, 1000);
    expect(tracker.predict(disabled)).toBe("likely-cold");
  });
  it("does not treat user activity, model/account changes or changed prefixes as cache hits", () => {
    const tracker = new ContextCacheTracker(() => 0);
    tracker.record(request);
    for (const change of [
      { modelId: "other" },
      { accountScope: "other" },
      { connectionId: "other" },
      { prefix: "changed" },
    ]) {
      expect(tracker.predict({ ...request, ...change })).toBe("likely-cold");
    }
    expect(tracker.predict({ ...request, capabilities: undefined })).toBe("unknown");
  });
  it("ignores transient Pi timestamps in prefix fingerprints", () => {
    expect(providerContextPrefix("stable", [], [user("first")])).toEqual(
      providerContextPrefix("stable", [], [{ ...user("first"), timestamp: 999 }]),
    );
  });
  it("fingerprints transcript instruction sections and tool changes", () => {
    const system = {
      role: "system",
      content: "Stable instructions",
      sections: { approval: "Pending" },
      toolsAdded: [{ name: "read_history", parameters: { type: "object" } }],
      toolsRemoved: [{ name: "old_tool" }],
      timestamp: 1,
    };
    const prefix = providerContextPrefix("", [], [system]);
    expect(prefix).toEqual(providerContextPrefix("", [], [{ ...system, timestamp: 2 }]));
    for (const changed of [
      { ...system, sections: { approval: "Granted" } },
      { ...system, toolsAdded: [] },
      { ...system, toolsRemoved: [] },
    ]) {
      expect(providerContextPrefix("", [], [changed])).not.toEqual(prefix);
    }
  });
  it("records observed cache reuse without pretending unknown measurements are zero", () => {
    const tracker = new ContextCacheTracker(() => 0);
    expect(tracker.record(request)).toEqual({ observedReuse: null });
    expect(tracker.record(request, 0)).toEqual({ observedReuse: false });
    expect(tracker.record(request, 1)).toEqual({ observedReuse: true });
  });
});

// Reference counts measured offline with cl100k, o200k, Llama 3, Qwen 2.5 and Mistral's
// original tokenizer: the fewest and most tokens any of them used for the sample.
const tokenizedSamples = [
  {
    name: "prose",
    text: "You are a helpful assistant for a small bakery. Answer customer questions about opening hours, prices, allergens and custom cake orders. Keep replies short and friendly, and never promise a delivery time you cannot confirm.\n\nWhen someone asks for a custom cake, collect the date they need it, the number of guests, any dietary restrictions, and the flavor they prefer. Repeat the details back before you save the order, and ask them to confirm. If the requested date is less than three days away, explain that rush orders cost extra and need approval from the owner.",
    fewest: 111,
    most: 119,
  },
  {
    name: "code",
    text: "export function retryDelay(attempt: number, baseMs = 500): number {\n  // Exponential backoff with a ceiling, so a flaky provider is not hammered.\n  const capped = Math.min(attempt, 6);\n  const jitter = (attempt * 37) % 100;\n  return baseMs * 2 ** capped + jitter;\n}\n\nfor (const [index, item] of items.entries()) {\n  if (!item.ready) continue;\n  results.push({ id: item.id, position: index, label: item.name.trim() });\n}\n",
    fewest: 116,
    most: 148,
  },
  {
    name: "a JSON tool schema",
    text: JSON.stringify({
      name: "ask_user",
      description:
        "Ask the user one short multiple-choice question with tappable options, then wait for their selection. Use this instead of asking them to type when two to four concise choices are enough.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", maxLength: 240 },
          options: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 80 },
            minItems: 2,
            maxItems: 4,
            uniqueItems: true,
          },
        },
        required: ["question", "options"],
      },
    }),
    fewest: 106,
    most: 125,
  },
  {
    name: "Chinese",
    text: "订阅凭据已安全存储。\n添加要监视的文件或文件夹\n请在设置中添加模型后再使用。\n添加通行密钥以更快登录？\n为此一次性任务添加运行时间。\n请填写服务器名称。\n添加触发器以运行此例程。\n请填写 HTTPS 服务器 URL。",
    fewest: 61,
    most: 104,
  },
  {
    name: "Japanese",
    text: "サブスクリプションの認証情報は安全に保存されています。\nアクセストークン（任意）\nアカウントのデフォルト\n実行するコマンドを追加\n監視するファイルまたはフォルダーを追加\nこれを使用するには、設定でモデルを追加してください。",
    fewest: 68,
    most: 114,
  },
  {
    name: "Russian",
    text: "Учётные данные подписки надежно сохранены.\nО пространствах\nТокен доступа (необязательно)\nУчетная запись по умолчанию\nЯрлык аккаунта\nДействия для пространства",
    fewest: 44,
    most: 72,
  },
  {
    name: "hex digests",
    text: "a5bb10eb6bdc95823faeb67d6545b23e0f9ab45fc9ec31eba52c13dfaff8ade7 0899cd856fba9b131050135138cd87c5e5222f0a0657b94730901988d5cabdbb 2be9fec91c2c7e4b40fedb0d2bf11da0f6fe4a7047946e3bd492a7377e7c6154 73014671303fd8235351b0a5e8aa8c6c6d19caf70d0d13900454afde0083d2a4",
    fewest: 154,
    most: 227,
  },
];
describe("text token estimate", () => {
  it.each(tokenizedSamples)(
    "stays near the least efficient tokenizer for $name",
    ({ text, fewest, most }) => {
      const estimate = estimateTextTokens(text);
      expect(estimate).toBeGreaterThanOrEqual(Math.floor(most * 0.9));
      expect(estimate).toBeLessThanOrEqual(Math.ceil(most * 1.5));
      expect(estimate).toBeLessThanOrEqual(fewest * 2.1);
      expect(estimate).toBeLessThanOrEqual(Buffer.byteLength(text, "utf8"));
    },
  );
  it("counts UTF-16 units instead of bytes", () => {
    const prose = tokenizedSamples[0]!.text;
    expect(estimateTextTokens(prose)).toBeLessThan(Buffer.byteLength(prose, "utf8") / 3);
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("🙂🙂")).toBe(5);
  });
});
