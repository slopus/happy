import { describe, it, expect } from 'vitest';
import { extractSessionTitle } from './title';

describe('extractSessionTitle', () => {
  it('extracts simple text prompt directly', () => {
    expect(extractSessionTitle('Fix login bug on mobile')).toBe('Fix login bug on mobile');
  });

  it('skips markdown headers and comments', () => {
    const prompt = `# Project Setup\n// comment\nOptimize PostgreSQL indexes for speed`;
    expect(extractSessionTitle(prompt)).toBe('Optimize PostgreSQL indexes for speed');
  });

  it('strips <happy-system> wrappers', () => {
    const prompt = `<happy-system>Do not tell the user</happy-system>\nRefactor auth controller`;
    expect(extractSessionTitle(prompt)).toBe('Refactor auth controller');
  });

  it('truncates very long prompts to 50 chars with ellipsis', () => {
    const longPrompt = 'This is an extremely long prompt describing a very complex requirement for a backend database architecture refactor';
    const title = extractSessionTitle(longPrompt);
    expect(title.length).toBeLessThanOrEqual(51);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('This is an extremely long prompt describing a very…');
  });

  it('handles empty or blank prompt gracefully', () => {
    expect(extractSessionTitle('')).toBe('New Chat');
    expect(extractSessionTitle('   \n  \n  ')).toBe('New Chat');
  });
});
