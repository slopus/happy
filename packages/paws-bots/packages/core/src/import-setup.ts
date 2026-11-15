import type { AgentImportSetupItem, AgentImportSetupState, MessageBlock } from "@rakazo/contracts";

/**
 * Needs Rakazo cannot check from its own data: what a skill declares, and a program or local
 * paths a stdio server relies on. Such rows are never shown as done.
 */
export function isImportSetupVerifiable(item: AgentImportSetupItem): boolean {
  if (item.kind === "skill") return false;
  if (item.kind !== "mcp") return true;
  return !item.needs.some((need) => need.kind === "program" || need.kind === "local_paths");
}

/** Null when it cannot be checked or is not read yet. */
export function isImportSetupDone(
  item: AgentImportSetupItem,
  state: AgentImportSetupState | null,
): boolean | null {
  if (!state || !isImportSetupVerifiable(item)) return null;
  if (item.kind === "model") return state.providers[item.provider] === true;
  if (item.kind === "mcp") return state.serverIds[item.serverId] === true;
  if (item.kind === "routine") return state.routineIds[item.routineId] === true;
  return null;
}

/** Every row is done; a row that cannot be checked keeps the checklist open. */
export function isImportSetupComplete(
  block: Extract<MessageBlock, { kind: "import_setup" }>,
  state: AgentImportSetupState | null,
): boolean {
  return Boolean(state) && block.items.every((item) => isImportSetupDone(item, state) === true);
}

/** What `bots.importSetupState` is asked about: each checkable item, by kind. */
export function importSetupStateInput(
  botId: string,
  block: Extract<MessageBlock, { kind: "import_setup" }>,
): { botId: string; providers: string[]; serverIds: string[]; routineIds: string[] } {
  const providers: string[] = [];
  const serverIds: string[] = [];
  const routineIds: string[] = [];
  for (const item of block.items) {
    if (item.kind === "model") providers.push(item.provider);
    else if (item.kind === "mcp") serverIds.push(item.serverId);
    else if (item.kind === "routine") routineIds.push(item.routineId);
  }
  return { botId, providers, serverIds, routineIds };
}
