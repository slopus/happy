/**
 * OpenCode Constants
 * 
 * Centralized constants for OpenCode integration including environment variable names
 * and default values.
 */

import { trimIdent } from '@/utils/trimIdent';

/** Environment variable name for OpenCode API key */
export const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';

/** Environment variable name for Anthropic API key (alternative for OpenCode) */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';

/** Environment variable name for OpenCode model selection */
export const OPENCODE_MODEL_ENV = 'OPENCODE_MODEL';

/** Default OpenCode model */
export const DEFAULT_OPENCODE_MODEL = 'anthropic/claude-sonnet-4-20250514';

/** Available OpenCode models */
export const AVAILABLE_OPENCODE_MODELS = [
  'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-opus-4-20250514',
  'openai/gpt-4o',
  'openai/o1',
  'google/gemini-2.5-pro',
];

/**
 * Instruction for changing chat title
 * Used in system prompts to instruct agents to call change_title function
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on this message, call functions.happy__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`
);
