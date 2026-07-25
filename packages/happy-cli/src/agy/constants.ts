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
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Default command name for the agy binary (looked up on PATH). */
export const AGY_BIN = 'agy';

/**
 * Resolve the agy executable to a spawnable command.
 *
 * agy installs to `~/.local/bin`, which is frequently absent from a daemon's
 * PATH (launchd, or `happy daemon start` from a non-login shell), so spawning
 * the bare name fails with ENOENT even though agy is installed. Resolution order:
 *   1. `HAPPY_AGY_PATH` env override — an explicit absolute path to the binary.
 *   2. `agy` already resolvable on PATH (then spawn the bare name).
 *   3. `~/.local/bin/agy` — the Antigravity CLI installer's default location.
 *
 * Falls back to the bare command name when nothing matches, so the caller still
 * spawns and surfaces a clear ENOENT instead of silently doing nothing.
 */
export function resolveAgyBin(): string {
  const override = process.env.HAPPY_AGY_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  // Already on PATH? Then the bare name is enough (and respects PATH ordering).
  try {
    const probe = process.platform === 'win32'
      ? `where ${AGY_BIN}`
      : `command -v ${AGY_BIN}`;
    execSync(probe, { stdio: 'ignore' });
    return AGY_BIN;
  } catch {
    // not on PATH — fall through to the known install location
  }

  const localBin = join(os.homedir(), '.local', 'bin', AGY_BIN);
  if (existsSync(localBin)) {
    return localBin;
  }

  return AGY_BIN;
}

/**
 * Stable model slugs accepted by `agy --model` (agy 1.1.5+), as printed by
 * `agy models` minus the per-effort suffix for models with variants (the
 * variant is chosen with `--effort`; see AGY_MODEL_EFFORT_LEVELS). agy still
 * accepts the full variant slugs and the pre-1.1.5 display names (e.g.
 * "Gemini 3.1 Pro (High)"), so previously stored selections keep working.
 */
export const AGY_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
] as const;

/**
 * Effort variants per base model slug. agy REQUIRES `--effort` for these models
 * (`--model gemini-3.1-pro` alone errors) and REJECTS it for models not listed
 * here, so the arg builder consults this map before emitting the flag.
 */
export const AGY_MODEL_EFFORT_LEVELS: Record<string, readonly string[]> = {
  'gemini-3.6-flash': ['low', 'medium', 'high'],
  'gemini-3.5-flash': ['low', 'medium', 'high'],
  'gemini-3.1-pro': ['low', 'high'],
};

/**
 * Default agy model. A Gemini model on purpose: this backend exists as a fallback
 * for when Claude Code is rate-limited, so we should not default onto a Claude model.
 */
export const DEFAULT_AGY_MODEL = 'gemini-3.1-pro';

/** Effort used when a variant model is selected without an explicit effort. */
export const DEFAULT_AGY_EFFORT = 'high';

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
