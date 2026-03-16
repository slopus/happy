import { trimIdent } from "@/utils/trimIdent";
import { getCommitAttribution } from "./claudeSettings";
import { getOrchestratorToolsInstruction } from '@/orchestrator/prompt';

/**
 * Base system prompt shared across all configurations
 */
const BASE_SYSTEM_PROMPT = (() => {
  const sections = [trimIdent(`
    # Chat title

    On your first response, call "mcp__happy__change_title" to set a descriptive title based on the user's message. Update the title whenever the conversation's main focus shifts to a different topic or task.
  `)];

  const orchestratorInstruction = getOrchestratorToolsInstruction();
  if (orchestratorInstruction) {
    sections.push(trimIdent(`
      # Orchestrator

      ${orchestratorInstruction}
    `));
  }

  return sections.join('\n\n');
})();

/**
 * System prompt with conditional commit attribution based on Claude's settings.json configuration.
 * Supports both the new `attribution` object and deprecated `includeCoAuthoredBy` boolean.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const attribution = getCommitAttribution();

  if (!attribution) {
    return BASE_SYSTEM_PROMPT;
  }

  return BASE_SYSTEM_PROMPT + '\n\n# Commit\n\nWhen making commit messages, add this footer:\n\n' + attribution;
})();
