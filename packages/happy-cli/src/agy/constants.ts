/**
 * Agy (Antigravity CLI) Constants
 *
 * Centralized constants for the agy integration: the binary name, the available
 * model display names (from `agy models`), the default model, and the print-mode
 * timeout. agy is a plain-text streaming CLI, so there are no env-var-based API
 * keys or MCP wiring like the Gemini ACP integration.
 */

import os from 'node:os';
import { join } from 'node:path';

/** Name of the agy binary on PATH. */
export const AGY_BIN = 'agy';

/**
 * Model display names accepted by `agy --model`, as printed by `agy models`.
 * agy expects the full display string, not a slug.
 */
export const AGY_MODELS = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
] as const;

/**
 * Default agy model. A Gemini model on purpose: this backend exists as a fallback
 * for when Claude Code is rate-limited, so we should not default onto a Claude model.
 */
export const DEFAULT_AGY_MODEL = 'Gemini 3.1 Pro (High)';

/** Timeout passed to `agy --print-timeout` for a single print turn. */
export const AGY_PRINT_TIMEOUT = '10m';

/**
 * Path to agy's per-workspace conversation cache. agy records the most recent
 * conversation id for each cwd here; print mode does not echo the id, so this is
 * how we recover it for `--conversation`-based resume.
 */
export const AGY_CONVERSATIONS_CACHE = join(
  os.homedir(),
  '.gemini',
  'antigravity-cli',
  'cache',
  'last_conversations.json',
);
