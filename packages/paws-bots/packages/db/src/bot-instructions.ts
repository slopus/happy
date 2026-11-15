import { randomUUID } from "node:crypto";
import { BOT_INSTRUCTIONS_MAX_LENGTH, InstructionVersionSchema } from "@rakazo/contracts";
import type { Prisma } from "./client.js";

export class InstructionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionConflictError";
  }
}

/** All instruction writers use the same row lock and bounded history. */
export async function writeBotInstructions(
  tx: Prisma.TransactionClient,
  input: {
    botId: string;
    instructions?: string;
    reason: string;
    versionId?: string;
    expectedInstructions?: string;
    undo?: boolean;
  },
) {
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
  const bot = await tx.bot.findUniqueOrThrow({ where: { id: input.botId } });
  if (input.versionId && input.expectedInstructions === undefined) {
    throw new InstructionConflictError("Review the current instructions before restoring.");
  }
  if (input.expectedInstructions !== undefined && bot.instructions !== input.expectedInstructions) {
    throw new InstructionConflictError(
      "Instructions changed; review the current instructions first.",
    );
  }
  const history = InstructionVersionSchema.array().parse(bot.instructionHistory);
  if (input.versionId && input.undo && history[0]?.id !== input.versionId)
    throw new InstructionConflictError(
      "Instructions changed; review the current instructions first.",
    );
  const instructions = input.versionId
    ? history.find((version) => version.id === input.versionId)?.instructions
    : input.instructions;
  if (instructions === undefined || instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    throw new InstructionConflictError("Instruction version is unavailable or too large.");
  }
  if (instructions === bot.instructions) return null;
  const version = {
    id: randomUUID(),
    instructions: bot.instructions,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  await tx.bot.update({
    where: { id: bot.id },
    data: {
      instructions,
      instructionHistory: [version, ...history].slice(0, 20),
    },
  });
  return version.id;
}
