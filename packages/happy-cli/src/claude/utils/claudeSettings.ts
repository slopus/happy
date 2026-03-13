/**
 * Utilities for reading Claude's settings.json configuration
 *
 * Handles reading Claude's settings.json file to respect user preferences
 * like attribution settings for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeAttribution {
  commit?: string;
  pr?: string;
}

export interface ClaudeSettings {
  attribution?: ClaudeAttribution;
  /** @deprecated Use attribution instead */
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

const DEFAULT_COMMIT_ATTRIBUTION = [
  'Generated with [Claude Code](https://claude.ai/code)',
  '',
  'Co-Authored-By: Claude <noreply@anthropic.com>',
].join('\n');

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(): string {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file from the default location
 *
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath();

    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }

    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;

    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] attribution: ${JSON.stringify(settings.attribution)}, includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);

    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Get the commit attribution text based on Claude's settings.
 *
 * Priority: attribution.commit (new) > includeCoAuthoredBy (deprecated) > default off
 *
 * @returns attribution text string, or null if attribution is disabled
 */
export function getCommitAttribution(): string | null {
  const settings = readClaudeSettings();
  if (!settings) return null;

  // New attribution field takes priority
  if (settings.attribution?.commit !== undefined) {
    return settings.attribution.commit || null;
  }

  // Fall back to deprecated includeCoAuthoredBy
  if (settings.includeCoAuthoredBy === true) {
    return DEFAULT_COMMIT_ATTRIBUTION;
  }

  return null;
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * @deprecated Use getCommitAttribution() instead
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  return getCommitAttribution() !== null;
}
