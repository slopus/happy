import { describe, expect, it, vi } from 'vitest';

vi.mock('@/claude/claudeLocal', () => ({
  claudeCliPath: '/mock/claude.js',
}));

const { buildSpawnPlan } = await import('./runOneShot');

describe('runOneShot spawn plan', () => {
  it('passes claude model and initial session-id arguments', () => {
    const plan = buildSpawnPlan('claude', 'hello', '/tmp/workdir', 'claude-sonnet-4-6', 'initial', 'session-uuid');
    expect(plan.command).toBe('node');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('claude-sonnet-4-6');
    expect(plan.args).toEqual(expect.arrayContaining(['--session-id', 'session-uuid']));
  });

  it('uses claude resume command for resume execution', () => {
    const plan = buildSpawnPlan('claude', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe('node');
    expect(plan.args).toEqual(['/mock/claude.js', '--resume', 'session-uuid', '-p', 'continue']);
  });

  it('decomposes codex model mode into --model and --reasoning-effort', () => {
    const plan = buildSpawnPlan('codex', 'hello', '/tmp/workdir', 'gpt-5.3-codex-high', 'initial');
    expect(plan.command).toBe('bash');
    expect(plan.args[0]).toBe('-lc');
    expect(plan.args[1]).toContain('@openai/codex@0.114.0');
    expect(plan.env?.ORCH_PROMPT).toBe('hello');
    expect(plan.env?.ORCH_MODEL).toBe('gpt-5.3-codex');
    expect(plan.env?.ORCH_REASONING_EFFORT).toBe('high');
  });

  it('uses codex resume command for resume execution', () => {
    const plan = buildSpawnPlan('codex', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe('bash');
    expect(plan.args[1]).toContain('exec resume "$ORCH_CHILD_SESSION_ID" "$ORCH_PROMPT"');
    expect(plan.env?.ORCH_CHILD_SESSION_ID).toBe('session-uuid');
  });

  it('passes gemini model as --model argument and outputs json for initial session capture', () => {
    const plan = buildSpawnPlan('gemini', 'hello', '/tmp/workdir', 'gemini-2.5-pro', 'initial');
    expect(plan.command).toBe('bash');
    expect(plan.args[0]).toBe('-lc');
    expect(plan.args[1]).toContain('gemini -p "$ORCH_PROMPT" --output-format json');
    expect(plan.env?.ORCH_PROMPT).toBe('hello');
    expect(plan.env?.ORCH_MODEL).toBe('gemini-2.5-pro');
  });

  it('uses gemini resume command for resume execution', () => {
    const plan = buildSpawnPlan('gemini', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe('bash');
    expect(plan.args[1]).toContain('gemini --resume "$ORCH_CHILD_SESSION_ID" -p "$ORCH_PROMPT"');
    expect(plan.env?.ORCH_CHILD_SESSION_ID).toBe('session-uuid');
  });
});
