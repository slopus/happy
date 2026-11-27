/**
 * Tests for Claude settings reading functionality
 * 
 * Tests reading Claude's settings.json file and respecting the includeCoAuthoredBy setting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, readConfiguredClaudeModel, shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });
    
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
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  describe('readClaudeSettings', () => {
    it('returns null when settings file does not exist', () => {
      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });

    it('reads settings when file exists', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      const testSettings = { includeCoAuthoredBy: false, otherSetting: 'value' };
      writeFileSync(settingsPath, JSON.stringify(testSettings));

      const settings = readClaudeSettings();
      expect(settings).toEqual(testSettings);
    });

    it('returns null when settings file is invalid JSON', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, 'invalid json');

      const settings = readClaudeSettings();
      expect(settings).toBe(null);
    });
  });

  describe('readConfiguredClaudeModel', () => {
    let project: string;

    beforeEach(() => {
      project = join(testClaudeDir, 'project');
      mkdirSync(join(project, '.claude'), { recursive: true });
    });

    it('is undefined when nothing names a model', () => {
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir })).toBeUndefined();
    });

    it('reads the user settings model', () => {
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5[1m]' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir })).toBe('claude-opus-5[1m]');
    });

    it('prefers project settings, local first, over the user settings', () => {
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
      writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-sonnet-5-5' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir })).toBe('claude-sonnet-5-5');
      writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir })).toBe('claude-haiku-5-5');
    });

    it('prefers ANTHROPIC_MODEL over every settings file', () => {
      writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir, ANTHROPIC_MODEL: 'claude-fable-5-2' })).toBe('claude-fable-5-2');
    });

    it('reads the user settings from the config dir Claude is given', () => {
      const other = join(testClaudeDir, 'other-config');
      mkdirSync(other);
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
      writeFileSync(join(other, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-5-5' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: other })).toBe('claude-sonnet-5-5');
    });

    it('skips blank and non-string models', () => {
      writeFileSync(join(project, '.claude', 'settings.local.json'), JSON.stringify({ model: ' ' }));
      writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ model: 5 }));
      writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
      expect(readConfiguredClaudeModel(project, { CLAUDE_CONFIG_DIR: testClaudeDir, ANTHROPIC_MODEL: '' })).toBe('opus');
    });
  });

  describe('shouldIncludeCoAuthoredBy', () => {
    it('returns true when no settings file exists (default behavior)', () => {
      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns true when includeCoAuthoredBy is not set (default behavior)', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });

    it('returns false when includeCoAuthoredBy is explicitly set to false', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: false }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(false);
    });

    it('returns true when includeCoAuthoredBy is explicitly set to true', () => {
      const settingsPath = join(testClaudeDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeCoAuthoredBy: true }));

      const result = shouldIncludeCoAuthoredBy();
      expect(result).toBe(true);
    });
  });
});