import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import {
  findGlobalClaudeCliPath,
  findClaudeInPath,
  detectSourceFromPath,
  findNpmGlobalCliPath,
  findBunGlobalCliPath,
  findHomebrewCliPath,
  findNativeInstallerCliPath,
  getVersion,
  compareVersions
} from '../scripts/claude_version_utils.cjs';

describe('Claude Version Utils - Cross-Platform Detection', () => {

  describe('detectSourceFromPath', () => {

    describe('npm installations', () => {
      it('should detect npm global installation on macOS/Linux', () => {
        const result = detectSourceFromPath('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm global installation on Windows with forward slashes', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should detect npm global installation on Windows with backslashes', () => {
        const result = detectSourceFromPath('C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
        expect(result).toBe('npm');
      });

      it('should not classify unrelated scoped npm packages as npm', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Roaming/npm/node_modules/@babel/core/cli.js');
        expect(result).toBe('PATH');
      });

      it('should detect npm through Homebrew', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should NOT detect Homebrew cask as npm', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js');
        expect(result).toBe('Homebrew');
      });
    });

    describe('Bun installations', () => {
      it('should detect Bun global installation on Unix', () => {
        const result = detectSourceFromPath('/Users/test/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun global installation on Windows', () => {
        const result = detectSourceFromPath('C:/Users/test/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun with @ symbol in username', () => {
        const result = detectSourceFromPath('C:/Users/@specialuser/.bun/bin/claude');
        expect(result).toBe('Bun');
      });

      it('should detect Bun in node_modules context', () => {
        const result = detectSourceFromPath('/Users/test/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('Bun');
      });
    });

    describe('Homebrew installations', () => {
      it('should detect Homebrew on Apple Silicon macOS', () => {
        const result = detectSourceFromPath('/opt/homebrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew on Intel macOS', () => {
        // Mock macOS platform
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

        const result = detectSourceFromPath('/usr/local/bin/claude');
        expect(result).toBe('Homebrew');

        // Restore original platform
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('should detect native installer on Linux for /usr/local/bin/claude', () => {
        // Mock Linux platform
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

        const result = detectSourceFromPath('/usr/local/bin/claude');
        expect(result).toBe('native installer');

        // Restore original platform
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });

      it('should detect Homebrew on Linux', () => {
        const result = detectSourceFromPath('/home/linuxbrew/.linuxbrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew user installation', () => {
        const result = detectSourceFromPath('/Users/test/.linuxbrew/bin/claude');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew cask with hashed directory', () => {
        const result = detectSourceFromPath('/opt/homebrew/lib/node_modules/@anthropic-ai/.claude-code-2DTsDk1V/cli.js');
        expect(result).toBe('Homebrew');
      });

      it('should detect Homebrew Cellar installation', () => {
        const result = detectSourceFromPath('/opt/homebrew/Cellar/claude-code/1.0.0/bin/claude');
        expect(result).toBe('Homebrew');
      });
    });

    describe('Native installer installations', () => {
      it('should detect native installer on Unix ~/.local', () => {
        const result = detectSourceFromPath('/Users/test/.local/bin/claude');
        expect(result).toBe('native installer');
      });

      it('should detect native installer with versioned structure', () => {
        const result = detectSourceFromPath('/Users/test/.local/share/claude/versions/2.0.69/claude');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows Program Files', () => {
        const result = detectSourceFromPath('C:/Program Files/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows AppData', () => {
        const result = detectSourceFromPath('C:/Users/test/AppData/Local/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows custom location', () => {
        const result = detectSourceFromPath('E:/Tools/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer on Windows D: drive', () => {
        const result = detectSourceFromPath('D:/Development/Claude/claude.exe');
        expect(result).toBe('native installer');
      });

      it('should detect native installer in user profile', () => {
        const result = detectSourceFromPath('C:/Users/test/.claude/claude.exe');
        expect(result).toBe('native installer');
      });
    });

    describe('Edge cases and special characters', () => {
      it('should handle @ symbols in paths correctly', () => {
        const result = detectSourceFromPath('/Users/@developer/test/node_modules/@anthropic-ai/claude-code/cli.js');
        expect(result).toBe('npm');
      });

      it('should handle case sensitivity variations on Windows', () => {
        const result = detectSourceFromPath('C:/USERS/TEST/APPDATA/ROAMING/NPM/NODE_MODULES/@ANTHROPIC-AI/CLAUDE-CODE/CLI.JS');
        expect(result).toBe('npm');
      });

      it('should return PATH for unrecognized paths', () => {
        const result = detectSourceFromPath('/some/random/path/claude');
        expect(result).toBe('PATH');
      });

      it('should handle empty paths', () => {
        const result = detectSourceFromPath('');
        expect(result).toBe('PATH');
      });

      it('should handle relative paths', () => {
        const result = detectSourceFromPath('./local/bin/claude');
        expect(result).toBe('PATH');
      });
    });
  });

  describe('Cross-platform compatibility', () => {
    it('should handle both forward and backward slashes', () => {
      const forward = detectSourceFromPath('C:/Users/test/AppData/Local/Claude/claude.exe');
      const backward = detectSourceFromPath('C:\\Users\\test\\AppData\\Local\\Claude\\claude.exe');

      expect(forward).toBe('native installer');
      expect(backward).toBe('native installer');
    });

    it('should handle Windows drive letters', () => {
      const drives = ['C:', 'D:', 'E:', 'Z:'];
      drives.forEach(drive => {
        const result = detectSourceFromPath(`${drive}/Program Files/Claude/claude.exe`);
        expect(result).toBe('native installer');
      });
    });

    it('should handle Unix-style absolute paths', () => {
      const unixPaths = [
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        '/home/user/.local/bin/claude'
      ];

      unixPaths.forEach(path => {
        const result = detectSourceFromPath(path);
        expect(['Homebrew', 'native installer']).toContain(result);
      });
    });
  });

  describe('Version comparison', () => {
    it('should compare versions correctly', () => {
      expect(compareVersions('2.0.69', '2.0.68')).toBe(1);
      expect(compareVersions('2.0.68', '2.0.69')).toBe(-1);
      expect(compareVersions('2.0.69', '2.0.69')).toBe(0);
      expect(compareVersions('2.1.0', '2.0.69')).toBe(1);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    it('should handle malformed versions gracefully', () => {
      expect(() => compareVersions('', '2.0.0')).not.toThrow();
      expect(() => compareVersions('invalid', '2.0.0')).not.toThrow();
      expect(() => compareVersions('2.0.0', '')).not.toThrow();
    });
  });

  describe('Integration scenarios', () => {
    it('should handle multiple installations scenario', () => {
      const scenarios = [
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },
        { path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },
        { path: 'C:/Program Files/Claude/claude.exe', expected: 'native installer' }
      ];

      scenarios.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        expect(result).toBe(expected);
      });
    });

    it('should maintain 100% success rate on all standard installation patterns', () => {
      const standardPatterns = [
        // npm (most common)
        { path: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },
        { path: 'C:/Users/test/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },

        // bun (second most common)
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: 'C:/Users/test/.bun/bin/claude', expected: 'Bun' },

        // homebrew (macOS and Linux)
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },
        { path: '/home/linuxbrew/.linuxbrew/bin/claude', expected: 'Homebrew' },
        { path: '/Users/test/.linuxbrew/bin/claude', expected: 'Homebrew' }, // LinuxBrew user installation

        // native installers
        { path: 'C:/Program Files/Claude/claude.exe', expected: 'native installer' },
        { path: 'C:/Users/test/AppData/Local/Claude/claude.exe', expected: 'native installer' },
        { path: '/Users/test/.local/bin/claude', expected: 'native installer' }
      ];

      let passed = 0;
      standardPatterns.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        if (result === expected) passed++;
      });

      expect(passed).toBe(standardPatterns.length);
      expect(passed / standardPatterns.length).toBe(1); // 100% success rate
    });

    it('should handle platform-specific /usr/local/bin/claude correctly', () => {
      const originalPlatform = process.platform;

      // Test on macOS (should be Homebrew)
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      const macosResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(macosResult).toBe('Homebrew');

      // Test on Linux (should be native installer)
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const linuxResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(linuxResult).toBe('native installer');

      // Test on Windows (should fallback to PATH)
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const windowsResult = detectSourceFromPath('/usr/local/bin/claude');
      expect(windowsResult).toBe('PATH');

      // Restore original platform
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    });
  });

  describe('Real-world edge cases', () => {
    it('should handle complex user scenarios', () => {
      const edgeCases = [
        // User with npm aliased to bun
        { path: '/Users/test/node_modules/@anthropic-ai/claude-code/cli.js', expected: 'npm' },

        // Multiple package managers
        { path: '/Users/test/.bun/bin/claude', expected: 'Bun' },
        { path: '/opt/homebrew/bin/claude', expected: 'Homebrew' },

        // Custom installations
        { path: '/opt/custom/claude/bin/claude', expected: 'PATH' },
        { path: '/usr/local/custom/bin/claude', expected: 'PATH' }
      ];

      edgeCases.forEach(({ path, expected }) => {
        const result = detectSourceFromPath(path);
        expect(result).toBe(expected);
      });
    });

    it('should handle path traversal and normalization', () => {
      const pathNormalizationTests = [
        { input: '/opt/homebrew/bin/../lib/claude', expected: 'Homebrew' },
        { input: '/Users/test/.bun/bin/./claude', expected: 'Bun' },
        { input: 'C:/Users/test/../test/AppData/Local/Claude/claude.exe', expected: 'native installer' }
      ];

      pathNormalizationTests.forEach(({ input, expected }) => {
        const result = detectSourceFromPath(input);
        expect(result).toBe(expected);
      });
    });
  });
});

describe('HAPPY_CLAUDE_PATH env var', () => {
  const testClaudePath = '/tmp/test-claude-path';

  beforeEach(() => {
    // Create mock executable
    fs.writeFileSync(testClaudePath, '#!/bin/bash\necho "mock"');
    fs.chmodSync(testClaudePath, 0o755);
  });

  afterEach(() => {
    if (fs.existsSync(testClaudePath)) fs.unlinkSync(testClaudePath);
    delete process.env.HAPPY_CLAUDE_PATH;
  });

  it('should use HAPPY_CLAUDE_PATH when set', () => {
    process.env.HAPPY_CLAUDE_PATH = testClaudePath;
    const result = findGlobalClaudeCliPath();
    expect(result?.source).toBe('HAPPY_CLAUDE_PATH');
    // Use realpathSync to handle macOS symlink (/tmp -> /private/tmp)
    expect(fs.realpathSync(result?.path ?? '')).toBe(fs.realpathSync(testClaudePath));
  });

  it('should fall back to auto-discovery when env var not set', () => {
    const result = findGlobalClaudeCliPath();
    expect(result?.source).not.toBe('HAPPY_CLAUDE_PATH');
  });

  it('should ignore env var if path does not exist', () => {
    process.env.HAPPY_CLAUDE_PATH = '/nonexistent/path/claude';
    const result = findGlobalClaudeCliPath();
    expect(result?.source).not.toBe('HAPPY_CLAUDE_PATH');
  });
});