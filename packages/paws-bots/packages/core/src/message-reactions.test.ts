import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { separateAskAnswers } from "./ask-replies.js";
import { messageReaction, projectMessageReactions } from "./message-reactions.js";

const message = (id: string, text: string, replyToMessageId?: string) => ({
  id,
  role: "user",
  blocks: [{ kind: "text", text }] as MessageBlock[],
  replyToMessageId,
});

describe("reaction conversation presentation", () => {
  it("keeps distinct and repeated reactions without replacing earlier messages", () => {
    const parent = message("parent", "Hello");
    const messages = [
      parent,
      message("one", "❤️", parent.id),
      message("two", "👍", parent.id),
      message("three", "❤️", parent.id),
    ];
    const result = projectMessageReactions(messages);
    expect(result.visibleMessages).toEqual([parent]);
    expect([...result.reactions.get(parent.id)!]).toEqual([
      ["❤️", 2],
      ["👍", 1],
    ]);
    expect(messages).toHaveLength(4);
  });
  it("keeps replies visible when their parent is outside the loaded page", () => {
    const reply = message("reply", "❤️", "old-parent");
    expect(projectMessageReactions([reply]).visibleMessages).toEqual([reply]);
  });
  it("does not collapse ordinary replies, standalone emoji, or bot messages", () => {
    expect(messageReaction(message("one", "❤️"))).toBeNull();
    expect(messageReaction(message("two", "❤️ thank you", "parent"))).toBeNull();
    expect(messageReaction({ ...message("three", "❤️", "parent"), role: "bot" })).toBeNull();
  });
});

it("keeps a linked emoji answer visible without duplicating it as a reaction or inline answer", () => {
  const ask: MessageBlock = {
    kind: "ask",
    text: "Does that work?",
    status: "answered",
    answer: "👍",
    answerMessageId: "answer",
  };
  const question = { id: "question", role: "bot", blocks: [ask] };
  const answer = message("answer", "👍", question.id);
  const reaction = message("reaction", "❤️", answer.id);
  const result = projectMessageReactions([question, answer, reaction]);
  expect(result.visibleMessages).toEqual([question, answer]);
  expect(result.reactions.has(question.id)).toBe(false);
  expect([...result.reactions.get(answer.id)!]).toEqual([["❤️", 1]]);
  expect(separateAskAnswers(result.visibleMessages).get(question.id)?.has(ask)).toBe(true);
});
