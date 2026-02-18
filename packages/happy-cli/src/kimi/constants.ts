/**
 * Kimi Constants
 *
 * Constants for Kimi CLI integration.
 */

/** Environment variable for Kimi API key */
export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';

/** Default model for Kimi */
export const DEFAULT_KIMI_MODEL = 'kimi-k2-0711-preview';

/** Available Kimi models */
export const AVAILABLE_KIMI_MODELS = [
  'kimi-k2-0711-preview',
  'kimi-k1.6-preview',
  'kimi-k1.5-preview',
] as const;

/** Change title instruction detection */
export const CHANGE_TITLE_INSTRUCTION = `
If the user asks you to change or set the conversation title, use the change_title tool.
`;
