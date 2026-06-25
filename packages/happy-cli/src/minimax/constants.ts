/**
 * MiniMax Constants
 *
 * Centralized constants for MiniMax integration including
 * environment variable names and default values.
 */

/** Environment variable name for MiniMax API key */
export const MINIMAX_API_KEY_ENV = 'MINIMAX_API_KEY';

/** Environment variable name for MiniMax base URL (for CN region: https://api.minimaxi.com) */
export const MINIMAX_BASE_URL_ENV = 'MINIMAX_BASE_URL';

/** Default MiniMax base URL (global) */
export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.io';

/** Default MiniMax model (M3: 512K context, 128K max output, image input support) */
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3';

/** Previous-generation model (kept as alternative) */
export const MINIMAX_M27_MODEL = 'MiniMax-M2.7';

/** Previous-generation high-speed model (kept as alternative) */
export const MINIMAX_HIGHSPEED_MODEL = 'MiniMax-M2.7-highspeed';

/** Full list of supported MiniMax models (default first) */
export const SUPPORTED_MINIMAX_MODELS = [
  DEFAULT_MINIMAX_MODEL,
  MINIMAX_M27_MODEL,
  MINIMAX_HIGHSPEED_MODEL,
] as const;
