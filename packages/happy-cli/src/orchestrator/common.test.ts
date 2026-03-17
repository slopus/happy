import { describe, expect, it } from 'vitest';
import {
  appendOutputChunk,
  buildOrchestratorEnv,
  buildOutputSummary,
  decodePromptFromBase64,
  mapFinishStatus,
  type OrchestratorDispatchPayload,
} from './common';

describe('orchestrator common helpers', () => {
  it('maps finish status by watchdog/cancel/exitCode priority', () => {
    expect(mapFinishStatus({ watchdogTriggered: true, cancelRequested: false, exitCode: 0 })).toBe('timeout');
    expect(mapFinishStatus({ watchdogTriggered: false, cancelRequested: true, exitCode: 0 })).toBe('cancelled');
    expect(mapFinishStatus({ watchdogTriggered: false, cancelRequested: false, exitCode: 0 })).toBe('completed');
    expect(mapFinishStatus({ watchdogTriggered: false, cancelRequested: false, exitCode: 1 })).toBe('failed');
  });

  it('builds env payload with base64 prompt', () => {
    const payload: OrchestratorDispatchPayload = {
      executionId: 'exec_1',
      runId: 'run_1',
      taskId: 'task_1',
      dispatchToken: 'token_1',
      provider: 'codex',
      executionType: 'initial',
      model: 'gpt-5.3-codex-high',
      prompt: '请总结这个目录',
      timeoutMs: 60_000,
      workingDirectory: '/tmp/project',
    };

    const env = buildOrchestratorEnv(payload);
    expect(env.HAPPY_ORCH_ONESHOT).toBe('1');
    expect(env.HAPPY_ORCH_EXECUTION_ID).toBe('exec_1');
    expect(env.HAPPY_ORCH_EXECUTION_TYPE).toBe('initial');
    expect(env.HAPPY_ORCH_MODEL_MODE).toBe('gpt-5.3-codex-high');
    expect(env.HAPPY_ORCH_TIMEOUT_MS).toBe('60000');
    expect(env.HAPPY_ORCH_WORKING_DIRECTORY).toBe('/tmp/project');
    expect(decodePromptFromBase64(env.HAPPY_ORCH_PROMPT_B64)).toBe(payload.prompt);
  });

  it('keeps output buffer tail when exceeding capture limit', () => {
    const first = appendOutputChunk('', 'abc', 5);
    const second = appendOutputChunk(first, 'def', 5);
    expect(second).toBe('bcdef');
  });

  it('builds summary from last non-empty line', () => {
    expect(buildOutputSummary('line1\nline2\n', '')).toBe('line2');
    expect(buildOutputSummary('', ' err line \n')).toBe('err line');
    expect(buildOutputSummary('   ', '   ')).toBeNull();
  });
});
