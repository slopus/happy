/**
 * Tests for Happy attribution settings
 *
 * Tests reading Happy's settings.json file for includeAttribution setting
 * Attribution is opt-in: defaults to false
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shouldIncludeAttribution, shouldIncludeCoAuthoredBy } from './claudeSettings';

describe('Happy Attribution Settings', () => {
  let testHappyDir: string;
  let originalHappyHomeDir: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for testing
    testHappyDir = join(tmpdir(), `test-happy-${Date.now()}`);
    mkdirSync(testHappyDir, { recursive: true });

    // Set environment variable to point to test directory
    originalHappyHomeDir = process.env.HAPPY_HOME_DIR;
    process.env.HAPPY_HOME_DIR = testHappyDir;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalHappyHomeDir !== undefined) {
      process.env.HAPPY_HOME_DIR = originalHappyHomeDir;
    } else {
      delete process.env.HAPPY_HOME_DIR;
    }

    // Clean up test directory
    if (existsSync(testHappyDir)) {
      rmSync(testHappyDir, { recursive: true, force: true });
    }
  });

  describe('shouldIncludeAttribution', () => {
    it('returns false when no settings file exists (opt-in default)', () => {
      const result = shouldIncludeAttribution();
      expect(result).toBe(false);
    });

    it('returns false when includeAttribution is not set (opt-in default)', () => {
      const settingsPath = join(testHappyDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ otherSetting: 'value' }));

      const result = shouldIncludeAttribution();
      expect(result).toBe(false);
    });

    it('returns false when includeAttribution is explicitly set to false', () => {
      const settingsPath = join(testHappyDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeAttribution: false }));

      const result = shouldIncludeAttribution();
      expect(result).toBe(false);
    });

    it('returns true when includeAttribution is explicitly set to true', () => {
      const settingsPath = join(testHappyDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeAttribution: true }));

      const result = shouldIncludeAttribution();
      expect(result).toBe(true);
    });

    it('returns false for invalid JSON settings file', () => {
      const settingsPath = join(testHappyDir, 'settings.json');
      writeFileSync(settingsPath, 'invalid json');

      const result = shouldIncludeAttribution();
      expect(result).toBe(false);
    });
  });

  describe('shouldIncludeCoAuthoredBy (legacy alias)', () => {
    it('returns same value as shouldIncludeAttribution', () => {
      // Default case
      expect(shouldIncludeCoAuthoredBy()).toBe(shouldIncludeAttribution());

      // With explicit true
      const settingsPath = join(testHappyDir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ includeAttribution: true }));
      expect(shouldIncludeCoAuthoredBy()).toBe(true);
    });
  });
});
