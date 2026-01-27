import { trimIdent } from '@/utils/trimIdent';

/**
 * Instruction for changing chat title.
 *
 * Used in system prompts to instruct agents to call `functions.happy__change_title`.
 */
export const CHANGE_TITLE_INSTRUCTION = trimIdent(
  `Based on this message, call functions.happy__change_title to change chat session title that would represent the current task. If chat idea would change dramatically - call this function again to update the title.`
);

