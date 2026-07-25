/**
 * Agy CLI argument builder
 *
 * Pure function that turns a turn's parameters into the argv for `agy --print`.
 * Kept separate from the backend so it can be unit-tested in isolation.
 */

import type { PermissionMode } from '@/api/types';
import { AGY_MODEL_EFFORT_LEVELS, DEFAULT_AGY_EFFORT } from './constants';

/**
 * Happy permission modes that map to agy's `--dangerously-skip-permissions`
 * (auto-approve every tool). Everything else falls back to `--sandbox`, letting
 * agy's own settings.json govern. Note: agy `--print` is one-shot and cannot
 * surface an interactive approval prompt, so non-skip modes auto-proceed under
 * agy's policy rather than gating per-tool in Happy.
 */
const SKIP_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set<PermissionMode>([
  'yolo',
  'safe-yolo',
  'bypassPermissions',
  'acceptEdits',
]);

export interface BuildAgyArgsOptions {
  /** The user prompt for this turn. */
  prompt: string;
  /** Model passed to `--model` — a stable slug (e.g. "gemini-3.1-pro") or a legacy display name. */
  model?: string;
  /** Effort level for models with `--effort` variants; ignored for models without them. */
  effort?: string | null;
  /** Conversation id to resume via `--conversation`; omit/null for a fresh conversation. */
  conversationId?: string | null;
  /** Happy permission mode for this turn. */
  permissionMode: PermissionMode;
  /** Directories to expose to agy via repeatable `--add-dir`. */
  addDirs?: string[];
  /** Value for `--print-timeout` (e.g. "10m"). */
  printTimeout?: string;
}

/**
 * Build the argv for a single `agy --print` invocation. The prompt is placed
 * last (as the value of `--print`) so all preceding flags parse cleanly.
 */
export function buildAgyArgs(opts: BuildAgyArgsOptions): string[] {
  const args: string[] = [];

  if (opts.conversationId) {
    args.push('--conversation', opts.conversationId);
  }
  if (opts.model) {
    args.push('--model', opts.model);
    // agy requires --effort for base slugs with variants ("--model gemini-3.1-pro"
    // alone is an error) and rejects it for everything else (fixed-variant slugs,
    // legacy display names), so gate the flag on the variant map.
    const levels = AGY_MODEL_EFFORT_LEVELS[opts.model];
    if (levels) {
      const effort = opts.effort && levels.includes(opts.effort) ? opts.effort : DEFAULT_AGY_EFFORT;
      args.push('--effort', effort);
    }
  }
  if (SKIP_PERMISSION_MODES.has(opts.permissionMode)) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--sandbox');
  }
  for (const dir of opts.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (opts.printTimeout) {
    args.push('--print-timeout', opts.printTimeout);
  }

  args.push('--print', opts.prompt);
  return args;
}
