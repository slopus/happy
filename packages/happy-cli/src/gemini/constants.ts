/**
 * Gemini Constants
 * 
 * Centralized constants for Gemini integration including environment variable names
 * and default values.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildFirstTurnToolingInstruction } from '@/orchestrator/prompt';

/** Environment variable name for Gemini API key */
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/** Environment variable name for Google API key (alternative) */
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';

/** Environment variable name for Gemini model selection */
export const GEMINI_MODEL_ENV = 'GEMINI_MODEL';

/** Default Gemini model */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';

/**
 * Instruction for changing chat title
 * Used in system prompts to instruct agents to call change_title function
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `On your first response, call "functions.happy__change_title" to set a descriptive title based on the user's message. Update the title whenever the conversation's main focus shifts to a different topic or task.`
);

/**
 * First-turn tool guidance shared by Codex + Gemini.
 * Includes chat title instruction and orchestrator delegation guidance for controller sessions.
 */
export function getFirstTurnInstruction(env: NodeJS.ProcessEnv = process.env): string {
  return buildFirstTurnToolingInstruction(CHANGE_TITLE_INSTRUCTION, env);
}

