import { describe, expect, it, vi } from 'vitest';

vi.mock('@/claude/claudeLocal', () => ({
  claudeCliPath: '/mock/claude.js',
}));
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

const { buildSpawnPlan } = await import('./runOneShot');

describe('runOneShot spawn plan', () => {
  it('passes claude model and initial session-id arguments', () => {
    const plan = buildSpawnPlan('claude', 'hello', '/tmp/workdir', 'claude-sonnet-4-6', 'initial', 'session-uuid');
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('claude-sonnet-4-6');
    expect(plan.args).toEqual(expect.arrayContaining(['--session-id', 'session-uuid']));
    expect(plan.args).toContain('--dangerously-skip-permissions');
  });

  it('uses claude resume command for resume execution', () => {
    const plan = buildSpawnPlan('claude', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual(['/mock/claude.js', '--dangerously-skip-permissions', '--resume', 'session-uuid', '-p', 'continue']);
  });

  it('decomposes codex model mode into --model and -c model_reasoning_effort', () => {
    const plan = buildSpawnPlan('codex', 'hello', '/tmp/workdir', 'gpt-5.3-codex-high', 'initial');
    expect(plan.command).toBe('npx');
    expect(plan.args).toContain('-y');
    expect(plan.args).toContain('@openai/codex@0.116.0');
    expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(plan.args).toContain('hello');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('gpt-5.3-codex');
    expect(plan.args).toContain('-c');
    expect(plan.args).toContain('model_reasoning_effort=high');
  });

  it('uses codex resume command for resume execution', () => {
    const plan = buildSpawnPlan('codex', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe('npx');
    expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(plan.args).toContain('resume');
    expect(plan.args).toContain('session-uuid');
    expect(plan.args).toContain('continue');
  });

  it('passes gemini model as --model argument and outputs json for initial session capture', () => {
    const plan = buildSpawnPlan('gemini', 'hello', '/tmp/workdir', 'gemini-2.5-pro', 'initial');
    expect(plan.command).toBe('gemini');
    expect(plan.args).toContain('--yolo');
    expect(plan.args).toContain('-p');
    expect(plan.args).toContain('hello');
    expect(plan.args).toContain('--output-format');
    expect(plan.args).toContain('json');
    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('gemini-2.5-pro');
  });

  it('uses gemini resume command for resume execution', () => {
    const plan = buildSpawnPlan('gemini', 'continue', '/tmp/workdir', undefined, 'resume', 'session-uuid');
    expect(plan.command).toBe('gemini');
    expect(plan.args).toContain('--yolo');
    expect(plan.args).toContain('--resume');
    expect(plan.args).toContain('session-uuid');
    expect(plan.args).toContain('-p');
    expect(plan.args).toContain('continue');
  });
});
