/**
 * Utilities for Happy attribution settings
 *
 * Controls whether Happy adds co-author attribution to git commits.
 * Settings are stored in Happy's own config (~/.happy/settings.json).
 */

import { readSettingsSync } from '@/persistence';

/**
 * Check if attribution should be included in commit messages
 *
 * Reads from Happy's settings.json. Attribution is OPT-IN:
 * - Returns true only if includeAttribution is explicitly set to true
 * - Returns false by default (no attribution without explicit consent)
 *
 * @returns true if attribution should be included, false otherwise
 */
export function shouldIncludeAttribution(): boolean {
  const settings = readSettingsSync();
  // Opt-in: only include if explicitly enabled
  return settings.includeAttribution === true;
}

// Legacy export for backwards compatibility
// Maps to new opt-in behavior
export function shouldIncludeCoAuthoredBy(): boolean {
  return shouldIncludeAttribution();
}
