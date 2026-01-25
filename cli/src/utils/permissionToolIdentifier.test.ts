import { describe, it, expect } from 'vitest';
import { extractShellCommand, isToolAllowedForSession, makeToolIdentifier } from './permissionToolIdentifier';

describe('permissionToolIdentifier', () => {
  it('extracts command from bash -lc wrapper arrays', () => {
    expect(extractShellCommand({ command: ['bash', '-lc', 'echo hello'] })).toBe('echo hello');
  });

  it('joins command arrays when not a shell wrapper', () => {
    expect(extractShellCommand({ command: ['git', 'status', '--porcelain'] })).toBe('git status --porcelain');
  });

  it('extracts command from items[] wrapper', () => {
    expect(extractShellCommand({ items: ['bash', '-lc', 'echo hello'] })).toBe('echo hello');
  });

  it('builds a specific identifier for bash with a command', () => {
    expect(makeToolIdentifier('bash', { command: ['bash', '-lc', 'echo hello'] })).toBe('bash(echo hello)');
  });

  it('keeps non-shell tool identifiers as toolName only', () => {
    expect(makeToolIdentifier('read', { path: 'foo' })).toBe('read');
  });

  it('accepts shell-tool synonyms for exact matches', () => {
    const allowed = new Set(['execute(git status)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git status' })).toBe(true);
  });

  it('accepts shell-tool synonyms for prefix matches', () => {
    const allowed = new Set(['execute(git status:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git status --porcelain' })).toBe(true);
  });

  it('accepts prefix matches even with leading env assignments', () => {
    const allowed = new Set(['execute(git:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'FOO=bar git status --porcelain' })).toBe(true);
  });

  it('does not treat chained commands as allowed unless each segment is allowed', () => {
    const allowed = new Set(['execute(git:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git status && rm -rf /tmp/x' })).toBe(false);
  });

  it('allows chained commands when each segment is allowed', () => {
    const allowed = new Set(['execute(git:*)', 'execute(rm:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git status && rm -rf /tmp/x' })).toBe(true);
  });

  it('does not treat pipelines as allowed unless each segment is allowed', () => {
    const allowed = new Set(['execute(git:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git diff | cat' })).toBe(false);
  });

  it('allows pipelines when each segment is allowed', () => {
    const allowed = new Set(['execute(git:*)', 'execute(cat:*)']);
    expect(isToolAllowedForSession(allowed, 'bash', { command: 'git diff | cat' })).toBe(true);
  });
});
