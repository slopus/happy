/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(env: Record<string, string | undefined> = process.env): string {
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

/**
 * Read Claude's settings.json file from the default location
 * 
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  return readSettingsFile(getClaudeSettingsPath());
}

function readSettingsFile(settingsPath: string): ClaudeSettings | null {
  try {
    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }
    
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;
    
    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    
    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * The model Claude Code runs when Happy passes none: `ANTHROPIC_MODEL`, else
 * `model` from the project's local settings, its shared settings, then the
 * user's, in the config dir `env` gives Claude. Undefined means the
 * account's own default, which only a turn's init message reveals.
 */
export function readConfiguredClaudeModel(
  workingDirectory: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = env.ANTHROPIC_MODEL?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const files = [
    join(workingDirectory, '.claude', 'settings.local.json'),
    join(workingDirectory, '.claude', 'settings.json'),
    getClaudeSettingsPath(env),
  ];
  for (const file of files) {
    const model = readSettingsFile(file)?.model;
    if (typeof model === 'string' && model.trim()) {
      return model.trim();
    }
  }
  return undefined;
}

/** Leave explicit commit attribution to Claude Code. */
export async function shouldIncludeCoAuthoredBy(cwd: string): Promise<boolean> {
  try {
    const { effective } = await resolveSettings({ cwd, settingSources: ['user', 'project', 'local'] });
    const attribution = effective.attribution;
    if (attribution === false || (typeof attribution === 'object' && attribution?.commit !== undefined)) {
      return false;
    }
    return effective.includeCoAuthoredBy !== false;
  } catch {
    logger.debug('[ClaudeSettings] Could not resolve Claude attribution settings');
    return false;
  }
}
