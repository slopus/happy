/**
 * OpenCode Constants
 * 
 * Centralized constants for OpenCode integration including environment variable names
 * and default values.
 */

import { trimIdent } from '@/utils/trimIdent';

/** Environment variable name for OpenCode model selection */
export const OPENCODE_MODEL_ENV = 'OPENCODE_MODEL';

/** Default command to run OpenCode ACP server */
export const OPENCODE_COMMAND = 'opencode';

/** Arguments to start OpenCode in ACP mode */
export const OPENCODE_ACP_ARGS = ['acp'];

/**
 * Instruction for changing chat title
 * Used in system prompts to instruct agents to call change_title function
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on this message, call functions.happy__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`
);
