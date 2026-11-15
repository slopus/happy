import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { separateAskAnswers } from "./ask-replies.js";

const question = (extra: Record<string, unknown> = {}) => ({
  id: "question",
  role: "bot",
  botId: "bot-1",
  blocks: [
    {
      kind: "ask",
      text: "What next?",
      status: "answered",
      answer: "Build a plan",
      answerMessageId: "reply",
      ...extra,
    },
  ] as MessageBlock[],
});
const reply = (text = "Build a plan", botId = "bot-1") => ({
  id: "reply",
  role: "user",
  botId,
  blocks: [{ kind: "text", text }] as MessageBlock[],
});

describe("separateAskAnswers", () => {
  it("suppresses only an answer also present in its linked visible user message", () => {
    const asked = question();
    expect([...separateAskAnswers([asked, reply()]).get("question")!]).toEqual([asked.blocks[0]]);
    expect(separateAskAnswers([question()]).size).toBe(0);
    expect(separateAskAnswers([question({ answerMessageId: undefined }), reply()]).size).toBe(0);
    expect(separateAskAnswers([question(), reply("Something else")]).size).toBe(0);
    expect(separateAskAnswers([question(), { ...reply(), id: "other-members-message" }]).size).toBe(
      0,
    );
  });

  it("keeps approvals, secrets and pending questions visible", () => {
    for (const extra of [
      { approvalEffectId: "effect" },
      { input: "secret" },
      { status: "pending" },
      { instructionUpdate: { after: "Build a plan" } },
    ]) {
      expect(separateAskAnswers([question(extra), reply()]).size).toBe(0);
    }
  });

  it("handles custom choice answers without treating an action id as reply text", () => {
    const actions = [{ id: "choice-1", label: "Build a plan" }];
    expect(
      separateAskAnswers([question({ actions, answer: "Custom plan" }), reply("Custom plan")]).size,
    ).toBe(1);
    expect(
      separateAskAnswers([question({ actions, answer: "choice-1" }), reply("choice-1")]).size,
    ).toBe(0);
    expect(separateAskAnswers([question({ actions, answer: "Build a plan" }), reply()]).size).toBe(
      0,
    );
  });

  it("follows the durable link even when another message intervenes", () => {
    expect(
      separateAskAnswers([question(), { id: "later", role: "bot", blocks: [] }, reply()]).size,
    ).toBe(1);
  });
});

it("identifies each linked block independently of sibling answers with the same text", () => {
  const linked = question().blocks[0]!;
  const cardOnly = question({ answerMessageId: undefined }).blocks[0]!;
  const selected = question({ actions: [{ id: "Build a plan", label: "Selected choice" }] })
    .blocks[0]!;
  const otherLinked = question({ answer: "Another answer", answerMessageId: "second-reply" })
    .blocks[0]!;
  const message = { ...question(), blocks: [linked, cardOnly, selected, otherLinked] };
  const secondReply = { ...reply("Another answer"), id: "second-reply" };
  const repeated = separateAskAnswers([message, reply(), secondReply]).get(message.id)!;
  expect([...repeated]).toEqual([linked, otherLinked]);
  expect(repeated.has(cardOnly)).toBe(false);
  expect(repeated.has(selected)).toBe(false);
});
