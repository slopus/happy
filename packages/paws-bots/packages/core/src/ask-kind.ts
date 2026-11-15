import type { MessageBlock } from "@rakazo/contracts";

export function isSecretAskBlock(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
}): boolean {
  return block.kind === "ask" && block.input === "secret" && !block.approvalEffectId;
}

/** A conversational question, separate from permission and protected-input requests. */
export function isQuestionAskBlock(block: MessageBlock): boolean {
  return (
    block.kind === "ask" &&
    !isSecretAskBlock(block) &&
    !block.approvalEffectId &&
    !block.instructionUpdate
  );
}
