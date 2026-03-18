/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  permissions?: {
    defaultMode?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

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
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);
    
    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Read a Claude settings file from a specific path.
 */
function readSettingsFile(path: string): ClaudeSettings | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeSettings;
  } catch {
    return null;
  }
}

/**
 * Get the default permission mode from Claude's settings files.
 * Checks with precedence: project local > project > user (matching Claude Code's scope system).
 *
 * @param projectDir - The project working directory (for project-level settings)
 * @returns The defaultMode value if set, or undefined
 */
export function getClaudeDefaultPermissionMode(projectDir?: string): string | undefined {
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

  // Read settings in precedence order (lowest to highest)
  const layers: ClaudeSettings[] = [];
  const userSettings = readSettingsFile(join(claudeConfigDir, 'settings.json'));
  if (userSettings) layers.push(userSettings);
  if (projectDir) {
    const projectSettings = readSettingsFile(join(projectDir, '.claude', 'settings.json'));
    if (projectSettings) layers.push(projectSettings);
    const localSettings = readSettingsFile(join(projectDir, '.claude', 'settings.local.json'));
    if (localSettings) layers.push(localSettings);
  }

  // Last layer wins (highest precedence)
  let mode: string | undefined;
  for (const layer of layers) {
    if (layer.permissions?.defaultMode) {
      mode = layer.permissions.defaultMode;
    }
  }

  if (mode) {
    logger.debug(`[ClaudeSettings] Resolved defaultMode: ${mode}`);
  }
  return mode;
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const settings = readClaudeSettings();
  
  // If no settings file or includeCoAuthoredBy is not explicitly set,
  // default to true to maintain backward compatibility
  if (!settings || settings.includeCoAuthoredBy === undefined) {
    return true;
  }
  
  return settings.includeCoAuthoredBy;
}