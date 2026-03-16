import { describe, expect, it } from 'vitest';
import {
  buildFirstTurnToolingInstruction,
  getOrchestratorToolsInstruction,
  isOrchestratorWorkerSession,
  shouldEnableOrchestratorTools,
} from './prompt';

describe('orchestrator prompt helpers', () => {
  it('detects worker session from oneshot marker', () => {
    expect(isOrchestratorWorkerSession({ HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOrchestratorWorkerSession({ HAPPY_ORCH_EXECUTION_ID: 'exec_1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOrchestratorWorkerSession({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('enables orchestrator tools for non-worker sessions', () => {
    expect(shouldEnableOrchestratorTools({} as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldEnableOrchestratorTools({
      HAPPY_ORCH_ONESHOT: '1',
    } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('only returns orchestrator instructions for controller sessions', () => {
    const controller = getOrchestratorToolsInstruction({} as NodeJS.ProcessEnv);
    expect(controller).toContain('orchestrator_submit');

    const worker = getOrchestratorToolsInstruction({ HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv);
    expect(worker).toBeNull();
  });

  it('appends orchestrator instructions onto first-turn base instruction', () => {
    const combined = buildFirstTurnToolingInstruction('change_title', {} as NodeJS.ProcessEnv);
    expect(combined).toContain('change_title');
    expect(combined).toContain('orchestrator_submit');

    const workerCombined = buildFirstTurnToolingInstruction('change_title', { HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv);
    expect(workerCombined).toBe('change_title');
  });
});
