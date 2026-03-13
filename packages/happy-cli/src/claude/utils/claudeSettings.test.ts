/**
 * Tests for Claude settings reading functionality
 *
 * Tests reading Claude's settings.json file and respecting both the new
 * `attribution` object and the deprecated `includeCoAuthoredBy` setting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readClaudeSettings, getCommitAttribution, shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Claude Settings', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    testClaudeDir = join(tmpdir(), `test-claude-${Date.now()}`);
    mkdirSync(testClaudeDir, { recursive: true });
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = testClaudeDir;
  });

  afterEach(() => {
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    if (existsSync(testClaudeDir)) {
      rmSync(testClaudeDir, { recursive: true, force: true });
    }
  });

  const writeSettings = (settings: Record<string, unknown>) => {
    writeFileSync(join(testClaudeDir, 'settings.json'), JSON.stringify(settings));
  };

  describe('readClaudeSettings', () => {
    it('returns null when settings file does not exist', () => {
      expect(readClaudeSettings()).toBe(null);
    });

    it('reads settings when file exists', () => {
      const testSettings = { includeCoAuthoredBy: false, otherSetting: 'value' };
      writeSettings(testSettings);
      expect(readClaudeSettings()).toEqual(testSettings);
    });

    it('returns null when settings file is invalid JSON', () => {
      writeFileSync(join(testClaudeDir, 'settings.json'), 'invalid json');
      expect(readClaudeSettings()).toBe(null);
    });
  });

  describe('getCommitAttribution', () => {
    it('returns null when no settings file exists (default off)', () => {
      expect(getCommitAttribution()).toBe(null);
    });

    it('returns null when neither attribution nor includeCoAuthoredBy is set', () => {
      writeSettings({ otherSetting: 'value' });
      expect(getCommitAttribution()).toBe(null);
    });

    // New attribution field
    it('returns custom text when attribution.commit is a non-empty string', () => {
      writeSettings({ attribution: { commit: 'Signed-off-by: Bot' } });
      expect(getCommitAttribution()).toBe('Signed-off-by: Bot');
    });

    it('returns null when attribution.commit is an empty string', () => {
      writeSettings({ attribution: { commit: '' } });
      expect(getCommitAttribution()).toBe(null);
    });

    it('returns null when attribution object exists but commit is not set', () => {
      writeSettings({ attribution: { pr: 'some pr text' } });
      expect(getCommitAttribution()).toBe(null);
    });

    // attribution takes priority over includeCoAuthoredBy
    it('attribution.commit takes priority over includeCoAuthoredBy', () => {
      writeSettings({ attribution: { commit: '' }, includeCoAuthoredBy: true });
      expect(getCommitAttribution()).toBe(null);
    });

    // Deprecated includeCoAuthoredBy fallback
    it('returns default text when includeCoAuthoredBy is true', () => {
      writeSettings({ includeCoAuthoredBy: true });
      const result = getCommitAttribution();
      expect(result).toContain('Co-Authored-By: Claude');
      expect(result).toContain('Generated with');
    });

    it('returns null when includeCoAuthoredBy is false', () => {
      writeSettings({ includeCoAuthoredBy: false });
      expect(getCommitAttribution()).toBe(null);
    });
  });

  describe('shouldIncludeCoAuthoredBy (deprecated wrapper)', () => {
    it('returns false when no settings', () => {
      expect(shouldIncludeCoAuthoredBy()).toBe(false);
    });

    it('returns true when attribution.commit is non-empty', () => {
      writeSettings({ attribution: { commit: 'custom' } });
      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });

    it('returns true when includeCoAuthoredBy is true', () => {
      writeSettings({ includeCoAuthoredBy: true });
      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });
  });
});
