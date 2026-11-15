export type InboundRoutine = { name: string; prompt: string };

/** How an inbound delivery (webhook, GitHub, messaging) quotes a routine it runs. */
export function inboundRoutineBlock(routine: InboundRoutine): string {
  return `Run routine "${routine.name}":\n${routine.prompt.trim()}`;
}

/**
 * The prompts of the routines an inbound task starts with. Those blocks come first and the
 * untrusted payload after them, and each must match one of `routines` exactly, so text in the
 * payload can never be taken for the owner's instructions.
 */
export function inboundRoutinePrompts(taskPrompt: string, routines: InboundRoutine[]): string[] {
  // Longest first: names need not be unique, and one routine's block can begin another's.
  const blocks = routines
    .map((routine) => ({
      block: `${inboundRoutineBlock(routine)}\n`,
      prompt: routine.prompt.trim(),
    }))
    .sort((a, b) => b.block.length - a.block.length);
  const prompts: string[] = [];
  let rest = taskPrompt;
  for (;;) {
    const match = blocks.find(({ block }) => rest.startsWith(block));
    if (!match) return prompts;
    prompts.push(match.prompt);
    rest = rest.slice(match.block.length);
  }
}
