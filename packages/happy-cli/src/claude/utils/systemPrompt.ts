import { getCommitAttribution } from "./claudeSettings";
import { getBaseSystemPrompt } from '@/orchestrator/prompt';

/**
 * System prompt with conditional commit attribution based on Claude's settings.json configuration.
 * Supports both the new `attribution` object and deprecated `includeCoAuthoredBy` boolean.
 * Settings are read once on startup for performance.
 *
 * Returns '' for worker sessions (getBaseSystemPrompt returns null).
 */
export const systemPrompt = (() => {
  const base = getBaseSystemPrompt();
  if (base === null) return ''; // Worker session — no system prompt

  const attribution = getCommitAttribution();
  if (!attribution) return base;

  return base + '\n\n# Commit\n\nWhen making commit messages, add this footer:\n\n' + attribution;
})();
