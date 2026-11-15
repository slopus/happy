import type { MessageBlock } from "@rakazo/contracts";
import { toolStepsHistoryText } from "@rakazo/core";
import type { Prisma } from "./client.js";

function objectBlocks(blocks: Prisma.JsonValue): MessageBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(
    (block) => block && typeof block === "object" && !Array.isArray(block),
  ) as MessageBlock[];
}

function toolSteps(block: MessageBlock): Extract<MessageBlock, { kind: "steps" }>["steps"] {
  return block.kind === "steps" && Array.isArray(block.steps)
    ? block.steps.filter((step) => typeof step?.label === "string")
    : [];
}

function conversationText(block: MessageBlock): string[] {
  if (block.kind === "subagent") return [block.task, block.result ?? ""].filter(Boolean);
  return [
    "text",
    "channel_message",
    "bot_message_received",
    "bot_message_sent",
    "handoff",
  ].includes(block.kind) &&
    "text" in block &&
    typeof block.text === "string"
    ? [block.text]
    : [];
}

/** Text only: progress, commands, secret prompts and tool traces are not exported content. */
export function historyMessageText(blocks: Prisma.JsonValue): string {
  return objectBlocks(blocks).flatMap(conversationText).join("\n");
}

/**
 * What history reads return to the bot: the message text plus an earlier reply's tool steps,
 * rendered in full (reads page through long text), so every search hit can be read.
 */
export function historyReadText(blocks: Prisma.JsonValue): string {
  return objectBlocks(blocks)
    .flatMap((block) => {
      const steps = toolSteps(block);
      return steps.length ? [toolStepsHistoryText(steps, { full: true })] : conversationText(block);
    })
    .join("\n");
}

/** The files and images a message carries, as their blocks. */
export function historyAttachmentBlocks(
  blocks: Prisma.JsonValue,
): Array<Extract<MessageBlock, { kind: "file" | "image" }>> {
  return objectBlocks(blocks).filter(
    (block): block is Extract<MessageBlock, { kind: "file" | "image" }> =>
      (block.kind === "file" || block.kind === "image") &&
      typeof block.artifactId === "string" &&
      typeof block.name === "string",
  );
}

/**
 * What history search matches: the message text, its tool steps' labels and notes, and the
 * names of its attachments. Mirrors the expression of messages_history_search_steps_idx.
 */
export function historySearchText(blocks: Prisma.JsonValue): string {
  const steps = objectBlocks(blocks).flatMap(toolSteps);
  return [
    historyMessageText(blocks),
    ...historyAttachmentBlocks(blocks).map((block) => block.name),
    ...steps.map((step) => step.label),
    ...steps.flatMap((step) => (typeof step.note === "string" ? [step.note] : [])),
  ]
    .filter(Boolean)
    .join("\n");
}
