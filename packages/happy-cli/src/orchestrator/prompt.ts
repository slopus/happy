import { trimIdent } from '@/utils/trimIdent';
import { ORCHESTRATOR_ENV_KEYS } from './common';

export const ORCHESTRATOR_V1_ENV_KEY = 'HAPPY_ORCHESTRATOR_V1';
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const ORCHESTRATOR_TOOLS_INSTRUCTION = trimIdent(`
  If a user request is large or benefits from parallel execution / cross-model delegation, use orchestrator_* tools.

  Preferred flow:
  1) Call orchestrator_get_context when you need defaults or controller context.
  2) Call orchestrator_submit with mode="blocking" when you must wait for delegated results before continuing.
  3) Call orchestrator_submit with mode="async" when you can continue work immediately, then use orchestrator_pend / orchestrator_list to track progress.
  4) Use orchestrator_cancel to stop a run when requested.

  After delegated runs complete, synthesize the outputs and continue the main task.
`);

export function isOrchestratorWorkerSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ORCHESTRATOR_ENV_KEYS.oneshot] === '1' || !!env[ORCHESTRATOR_ENV_KEYS.executionId];
}

export function isOrchestratorV1Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORCHESTRATOR_V1_ENV_KEY];
  if (!raw) {
    return false;
  }
  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

export function shouldEnableOrchestratorTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOrchestratorV1Enabled(env) && !isOrchestratorWorkerSession(env);
}

export function getOrchestratorToolsInstruction(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!shouldEnableOrchestratorTools(env)) {
    return null;
  }
  return ORCHESTRATOR_TOOLS_INSTRUCTION;
}

export function buildFirstTurnToolingInstruction(
  baseInstruction: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const orchestratorInstruction = getOrchestratorToolsInstruction(env);
  if (!orchestratorInstruction) {
    return baseInstruction;
  }
  return `${baseInstruction}\n\n${orchestratorInstruction}`;
}
