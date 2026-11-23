/**
 * Tests for Claude settings reading functionality
 * 
 * Tests reading Claude's settings.json file and respecting the includeCoAuthoredBy setting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = mkdtempSync(join(tmpdir(), 'happy-claude-settings-'));
    
    // Set environment variable to point to test directory
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    
    // Clean up test directory
    rmSync(testClaudeDir, { recursive: true, force: true });
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    it('returns true when no settings file exists (default behavior)', async () => {
      const result = await shouldIncludeCoAuthoredBy(testClaudeDir);
      expect(result).toBe(true);
    });

    it('returns true when includeCoAuthoredBy is not set (default behavior)', async () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = await shouldIncludeCoAuthoredBy(testClaudeDir);
      expect(result).toBe(true);
    });

    it('respects a project opt-out ahead of the user default', async () => {
      const project = join(testClaudeDir, 'project');
      const settings = join(project, '.claude');
      mkdirSync(settings, { recursive: true });
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ includeCoAuthoredBy: true }));
      writeFileSync(join(settings, 'settings.json'), JSON.stringify({ includeCoAuthoredBy: false }));

      expect(await shouldIncludeCoAuthoredBy(project)).toBe(false);

      writeFileSync(join(settings, 'settings.local.json'), JSON.stringify({ includeCoAuthoredBy: true }));
      expect(await shouldIncludeCoAuthoredBy(project)).toBe(true);
    });

    it('defers to Claude when commit attribution is explicitly configured', async () => {
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ attribution: { commit: '' } }));

      expect(await shouldIncludeCoAuthoredBy(testClaudeDir)).toBe(false);
    });

    it('returns false when includeCoAuthoredBy is explicitly set to false', async () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));

      const result = await shouldIncludeCoAuthoredBy(testClaudeDir);
      expect(result).toBe(false);
    });

    it('returns true when includeCoAuthoredBy is explicitly set to true', async () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      const result = await shouldIncludeCoAuthoredBy(testClaudeDir);
      expect(result).toBe(true);
    });
  });
});