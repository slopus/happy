import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression tests for findClaudeInPath() resolving the native-installer
 * Claude Code binary.
 *
 * The native installer (>= 2.1.113) ships a self-contained, extensionless
 * compiled binary at ~/.local/share/claude/versions/<ver>. findClaudeInPath()
 * used to treat any resolved path without a .js/.cjs/.exe extension as a
 * Windows npm shim, look for an adjacent node_modules/@anthropic-ai/claude-code,
 * and — finding none on Unix — return null. happy then silently fell back to a
 * different (often older) install, e.g. a stale Homebrew copy. These tests pin
 * the fix: on macOS/Linux the extensionless native binary is used directly.
 */

// Hoisted so the vi.mock factories below can read/mutate it per test.
const state = vi.hoisted(() => ({
  whichOutput: '',
  existing: new Set<string>(),
  symlinks: new Map<string, string>(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => state.whichOutput),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => state.existing.has(p)),
  realpathSync: vi.fn((p: string) => state.symlinks.get(p) ?? p),
  // Unused by findClaudeInPath but referenced elsewhere in the module.
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isFile: () => true, isDirectory: () => false })),
}));

// Import after mocks are registered.
import { findClaudeInPath } from '../scripts/claude_version_utils.cjs';

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('findClaudeInPath - native installer (extensionless binary)', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    state.whichOutput = '';
    state.existing = new Set();
    state.symlinks = new Map();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.clearAllMocks();
  });

  it('resolves the native binary on Linux instead of returning null', () => {
    setPlatform('linux');
    const symlink = '/home/user/.local/bin/claude';
    const binary = '/home/user/.local/share/claude/versions/2.1.175/claude';
    state.whichOutput = `${symlink}\n`;
    state.existing.add(symlink).add(binary);
    state.symlinks.set(symlink, binary);

    const result = findClaudeInPath();

    expect(result).not.toBeNull();
    expect(result?.path).toBe(binary);
    expect(result?.source).toBe('native installer');
  });

  it('resolves the native binary on macOS (~/.local/bin -> versions/<ver>)', () => {
    setPlatform('darwin');
    const symlink = '/Users/test/.local/bin/claude';
    const binary = '/Users/test/.local/share/claude/versions/2.1.175';
    state.whichOutput = `${symlink}\n`;
    state.existing.add(symlink).add(binary);
    state.symlinks.set(symlink, binary);

    const result = findClaudeInPath();

    expect(result?.path).toBe(binary);
    expect(result?.source).toBe('native installer');
  });

  it('still resolves a .js cli entrypoint (npm) normally', () => {
    setPlatform('linux');
    const symlink = '/home/user/.nvm/versions/node/v22.19.0/bin/claude';
    const cli = '/home/user/.nvm/versions/node/v22.19.0/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    state.whichOutput = `${symlink}\n`;
    state.existing.add(symlink).add(cli);
    state.symlinks.set(symlink, cli);

    const result = findClaudeInPath();

    expect(result?.path).toBe(cli);
    expect(result?.source).toBe('npm');
  });
});
