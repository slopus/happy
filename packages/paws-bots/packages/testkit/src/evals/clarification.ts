export type ClarificationBlock = {
  kind: string;
  text?: string;
  detail?: string;
  status?: string;
  input?: string;
  approvalEffectId?: string;
  actions?: Array<{ label: string }>;
};

/** Only explicit clarification fixtures may treat a pending choice as an outcome. */
export function expectedClarificationText(
  expected: boolean,
  status: string,
  toolNames: readonly string[],
  blocks: readonly ClarificationBlock[],
): string | null {
  if (!expected || status !== "waiting_input" || !toolNames.includes("ask_user")) return null;
  const asks = blocks.filter((block) => block.kind === "ask" && block.status === "pending");
  if (
    asks.length !== 1 ||
    asks[0]!.input !== undefined ||
    asks[0]!.approvalEffectId !== undefined ||
    !asks[0]!.text?.trim() ||
    !asks[0]!.actions ||
    asks[0]!.actions!.length < 2 ||
    asks[0]!.actions!.length > 4 ||
    asks[0]!.actions!.some((action) => !action.label.trim())
  )
    return null;
  const ask = asks[0]!;
  // Option labels and details are visible evidence too, including forbidden identifiers.
  return [ask.text, ask.detail, ...ask.actions!.map((action) => action.label)]
    .filter(Boolean)
    .join("\n");
}
