import { describe, expect, it, vi } from 'vitest';

vi.mock('@/claude/claudeLocal', () => ({
  claudeCliPath: '/mock/claude.js',
}));

const { buildSpawnPlan } = await import('./runOneShot');

describe('runOneShot spawn plan', () => {
  it('passes claude model as --model argument', () => {
    const plan = buildSpawnPlan('claude', 'hello', '/tmp/workdir', 'claude-sonnet-4-6');
    expect(plan.command).toBe('node');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('claude-sonnet-4-6');
  });

  it('decomposes codex model mode into --model and --reasoning-effort', () => {
    const plan = buildSpawnPlan('codex', 'hello', '/tmp/workdir', 'gpt-5.3-codex-high');
    expect(plan.command).toBe('bash');
    expect(plan.args[0]).toBe('-lc');
    expect(plan.args[1]).toContain('@openai/codex@0.114.0');
    expect(plan.env?.ORCH_PROMPT).toBe('hello');
    expect(plan.env?.ORCH_MODEL).toBe('gpt-5.3-codex');
    expect(plan.env?.ORCH_REASONING_EFFORT).toBe('high');
  });

  it('passes gemini model as --model argument', () => {
    const plan = buildSpawnPlan('gemini', 'hello', '/tmp/workdir', 'gemini-2.5-pro');
    expect(plan.command).toBe('bash');
    expect(plan.args[0]).toBe('-lc');
    expect(plan.args[1]).toContain('gemini -p "$ORCH_PROMPT"');
    expect(plan.env?.ORCH_PROMPT).toBe('hello');
    expect(plan.env?.ORCH_MODEL).toBe('gemini-2.5-pro');
  });
});
