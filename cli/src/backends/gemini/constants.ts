/**
 * Gemini Constants
 * 
 * Centralized constants for Gemini integration including environment variable names
 * and default values.
 */

import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';

/** Environment variable name for Gemini API key */
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

/** Environment variable name for Google API key (alternative) */
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';

/** Environment variable name for Gemini model selection */
export const GEMINI_MODEL_ENV = 'GEMINI_MODEL';

/** Default Gemini model */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro';

// Back-compat export (this constant is shared across agents, not Gemini-specific).
export { CHANGE_TITLE_INSTRUCTION };
