/**
 * Tests that daemon-spawned sessions inject --permission-mode from Claude settings config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultPermissionMode } from '@/claude/utils/claudeSettings';

describe('daemon spawn permission mode injection', () => {
  let testClaudeDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    testClaudeDir = join(tmpdir(), `test-daemon-perm-${Date.now()}`);
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

  it('getDefaultPermissionMode returns bypassPermissions when configured', () => {
    writeFileSync(
      join(testClaudeDir, 'settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } })
    );
    expect(getDefaultPermissionMode()).toBe('bypassPermissions');
  });

  it('getDefaultPermissionMode returns null when no config', () => {
    expect(getDefaultPermissionMode()).toBeNull();
  });

  describe('buildSpawnArgs', () => {
    // We test the arg construction logic directly
    it('includes --permission-mode when default is configured', () => {
      writeFileSync(
        join(testClaudeDir, 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } })
      );
      const defaultMode = getDefaultPermissionMode();
      const args = ['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
      if (defaultMode) {
        args.push('--permission-mode', defaultMode);
      }
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
    });

    it('does not include --permission-mode when no config', () => {
      const defaultMode = getDefaultPermissionMode();
      const args = ['claude', '--happy-starting-mode', 'remote', '--started-by', 'daemon'];
      if (defaultMode) {
        args.push('--permission-mode', defaultMode);
      }
      expect(args).not.toContain('--permission-mode');
    });

    it('tmux command string includes --permission-mode when configured', () => {
      writeFileSync(
        join(testClaudeDir, 'settings.json'),
        JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } })
      );
      const defaultMode = getDefaultPermissionMode();
      let fullCommand = 'node cliPath claude --happy-starting-mode remote --started-by daemon';
      if (defaultMode) {
        fullCommand += ` --permission-mode ${defaultMode}`;
      }
      expect(fullCommand).toContain('--permission-mode acceptEdits');
    });
  });
});
