/**
 * Tests for Claude settings reading functionality
 * 
 * Tests reading Claude's settings.json file and respecting the includeCoAuthoredBy setting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, shouldIncludeCoAuthoredBy, getClaudeDefaultPermissionMode } from './claudeSettings';

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

  describe('getClaudeDefaultPermissionMode', () => {
    it('returns undefined when no settings files exist', () => {
      expect(getClaudeDefaultPermissionMode()).toBeUndefined();
    });

    it('reads defaultMode from user settings', () => {
      writeFileSync(
        join(testClaudeDir, 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
      );
      expect(getClaudeDefaultPermissionMode()).toBe('bypassPermissions');
    });

    it('returns undefined when permissions has no defaultMode', () => {
      writeFileSync(
        join(testClaudeDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: [] } }),
      );
      expect(getClaudeDefaultPermissionMode()).toBeUndefined();
    });

    it('project settings override user settings', () => {
      writeFileSync(
        join(testClaudeDir, 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'default' } }),
      );
      const projectDir = join(tmpdir(), `test-project-${Date.now()}`);
      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }),
      );
      expect(getClaudeDefaultPermissionMode(projectDir)).toBe('bypassPermissions');
      rmSync(projectDir, { recursive: true, force: true });
    });

    it('local settings override project settings', () => {
      const projectDir = join(tmpdir(), `test-project-${Date.now()}`);
      mkdirSync(join(projectDir, '.claude'), { recursive: true });
      writeFileSync(
        join(projectDir, '.claude', 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'default' } }),
      );
      writeFileSync(
        join(projectDir, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
      );
      expect(getClaudeDefaultPermissionMode(projectDir)).toBe('acceptEdits');
      rmSync(projectDir, { recursive: true, force: true });
    });
  });
});