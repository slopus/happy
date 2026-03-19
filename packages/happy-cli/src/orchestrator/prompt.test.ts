import { describe, expect, it } from 'vitest';
import {
  buildFirstTurnToolingInstruction,
  getBaseSystemPrompt,
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
    expect(controller).toContain('# Orchestrator');
    expect(controller).toContain('orchestrator_');
    expect(controller).toContain('get_context');

    const worker = getOrchestratorToolsInstruction({ HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv);
    expect(worker).toBeNull();
  });

  it('only returns BASE_SYSTEM_PROMPT for controller sessions', () => {
    const controller = getBaseSystemPrompt({} as NodeJS.ProcessEnv);
    expect(controller).toContain('# Chat title');
    expect(controller).toContain('# Orchestrator');

    const worker = getBaseSystemPrompt({ HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv);
    expect(worker).toBeNull();
  });

  it('appends orchestrator instructions onto first-turn base instruction', () => {
    const combined = buildFirstTurnToolingInstruction('change_title', {} as NodeJS.ProcessEnv);
    expect(combined).toContain('change_title');
    expect(combined).toContain('# Orchestrator');
    expect(combined).toContain('orchestrator_');

    const workerCombined = buildFirstTurnToolingInstruction('change_title', { HAPPY_ORCH_ONESHOT: '1' } as NodeJS.ProcessEnv);
    expect(workerCombined).toBe('change_title');
  });
});
