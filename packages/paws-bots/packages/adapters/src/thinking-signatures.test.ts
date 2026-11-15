import type { TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  isThinkingSignatureMismatch,
  withoutThinkingBlocks,
  withoutThinkingFrom,
} from "./thinking-signatures.js";

describe("thinking signatures bound to a different conversation", () => {
  it("recognizes the provider error, also through proxies", () => {
    expect(
      isThinkingSignatureMismatch(
        "400 Upstream request failed: [invalid_request_error] messages.1.content.7: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
      ),
    ).toBe(true);
    expect(isThinkingSignatureMismatch("Invalid signature in thinking block")).toBe(true);
    expect(
      isThinkingSignatureMismatch(
        '400 {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"The encrypted content for item rs_1 could not be verified.\\",\\"code\\":\\"invalid_encrypted_content\\"}}","provider_error_code":"invalid_encrypted_content"}}',
      ),
    ).toBe(true);
    expect(isThinkingSignatureMismatch("thinking.adaptive.block_binding: Extra inputs")).toBe(
      false,
    );
    expect(isThinkingSignatureMismatch("invalid api key")).toBe(false);
    expect(isThinkingSignatureMismatch(undefined)).toBe(false);
  });

  it("removes thinking from assistant messages and keeps everything else", () => {
    const context = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "hi", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t", thinkingSignature: "sig" },
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: "x",
              redacted: true,
            },
            { type: "text", text: "hello" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "plain" }] },
      ],
    } as unknown as TranscriptContext;
    const stripped = withoutThinkingBlocks(context);
    expect((stripped as { systemPrompt?: string }).systemPrompt).toBe("s");
    expect(stripped.messages[0]).toBe(context.messages[0]);
    expect(stripped.messages[1]).toMatchObject({ content: [{ type: "text", text: "hello" }] });
    expect(stripped.messages[2]).toBe(context.messages[2]);
    expect(context.messages[1]).toMatchObject({ content: { length: 3 } });
    const plain = { messages: [context.messages[0]] } as unknown as TranscriptContext;
    expect(withoutThinkingBlocks(plain)).toBe(plain);
  });

  it("removes thinking only from messages at or after the given index", () => {
    const assistant = (id: string) =>
      ({
        role: "assistant",
        content: [
          { type: "thinking", thinking: id, thinkingSignature: id },
          { type: "toolCall", id, name: "tool", arguments: {} },
        ],
        timestamp: 0,
      }) as unknown as TranscriptContext["messages"][number];
    const onlyThinking = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "t", thinkingSignature: "t" }],
      timestamp: 0,
    } as unknown as TranscriptContext["messages"][number];
    const messages = [assistant("a"), assistant("b"), onlyThinking];
    const thinking = (list: typeof messages) =>
      list.map((message) =>
        message.role === "assistant"
          ? message.content.filter((part) => part.type === "thinking").length
          : 0,
      );
    expect(thinking(withoutThinkingFrom(messages, 0))).toEqual([0, 0, 0]);
    expect(thinking(withoutThinkingFrom(messages, 1))).toEqual([1, 0, 0]);
    expect(withoutThinkingFrom(messages, 3)).toBe(messages);
    expect(withoutThinkingFrom(messages, 99)).toBe(messages);
    // A message left empty stays in place so indexes keep lining up; the provider adapter skips it.
    expect(withoutThinkingFrom(messages, 2)[2]).toMatchObject({ role: "assistant", content: [] });
    const plain = [{ role: "user", content: "hi", timestamp: 0 }] as TranscriptContext["messages"];
    expect(withoutThinkingFrom(plain, 0)).toBe(plain);
  });

  it("keeps thinking that carries no signature", () => {
    const assistant = (...thinking: object[]) =>
      ({
        role: "assistant",
        content: [...thinking, { type: "text", text: "reply" }],
        timestamp: 0,
      }) as unknown as TranscriptContext["messages"][number];
    const messages = [
      assistant({ type: "thinking", thinking: "bare" }),
      assistant({ type: "thinking", thinking: "field", thinkingSignature: "reasoning_content" }),
      assistant({ type: "thinking", thinking: "signed", thinkingSignature: "EqQBCkYI" }),
      assistant({ type: "thinking", thinking: "", thinkingSignature: "x", redacted: true }),
    ];
    const kept = withoutThinkingFrom(messages, 0).map((message) =>
      message.role === "assistant"
        ? message.content.filter((part) => part.type === "thinking").map((part) => part.thinking)
        : [],
    );
    expect(kept).toEqual([["bare"], ["field"], [], []]);
    const unsigned = messages.slice(0, 2);
    expect(withoutThinkingFrom(unsigned, 0)).toBe(unsigned);
  });
});
