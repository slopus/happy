import { MODEL_CONTEXT_TOO_SMALL_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { selectContext } from "./context-selection.js";
import { resolveCompletionMaxTokens } from "./pi-runtime-limits.js";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";

const instructions = [
  "You are a helpful assistant for a small bakery. Answer customer questions about opening hours, prices, allergens and custom cake orders. Keep replies short and friendly, and never promise a delivery time you cannot confirm.",
  "When someone asks for a custom cake, collect the date they need it, the number of guests, any dietary restrictions, and the flavor they prefer. Repeat the details back before you save the order, and ask them to confirm.",
  "Every morning, check the shared inventory sheet and tell the team which ingredients are running low. Draft a reorder message but do not send it until someone on the team approves it.",
].join("\n\n");

function typicalBotBudget(contextWindow: number) {
  const tools = selectBuiltinToolsForRun({
    historyRetrievalEnabled: true,
    graphicalToolsAllowed: false,
    groupId: null,
    trigger: "user",
    semanticMemoryEnabled: false,
    messagingChannelRun: false,
  }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
  return {
    contextWindow,
    // A reasoning model reserves the most output room.
    outputReserve: resolveCompletionMaxTokens(undefined, undefined, undefined, true, contextWindow),
    systemPrompt: instructions,
    tools,
  };
}

describe("model context budget", () => {
  it("fits a typical bot's instructions and tools in a 32k window", () => {
    const budget = typicalBotBudget(32_768);
    // A raw byte count would fill the window before any conversation.
    expect(Buffer.byteLength(JSON.stringify(budget.tools), "utf8")).toBeGreaterThan(
      budget.contextWindow - budget.outputReserve,
    );
    const selected = selectContext(
      [{ role: "user", content: "Do you have gluten-free cakes this weekend?" }],
      { budget, strategy: "current" },
    );
    expect(selected.messages).toHaveLength(1);
    expect(selected.estimatedInputTokens).toBeLessThan(budget.contextWindow - budget.outputReserve);
  });

  it("still refuses an 8k window the same tools cannot fit", () => {
    expect(() =>
      selectContext([{ role: "user", content: "hi" }], {
        budget: typicalBotBudget(8_192),
        strategy: "current",
      }),
    ).toThrow(MODEL_CONTEXT_TOO_SMALL_ERROR);
  });
});
