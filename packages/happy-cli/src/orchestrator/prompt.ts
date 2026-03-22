import { trimIdent } from '@/utils/trimIdent';
import { ORCHESTRATOR_ENV_KEYS } from './common';

export const CHAT_TITLE_INSTRUCTION = trimIdent(`
  # Chat title

  On your first response, call "change_title" to set a descriptive title based on the user's message. Update the title whenever the conversation's main focus shifts to a different topic or task.
`);

export const ORCHESTRATOR_TOOLS_INSTRUCTION = trimIdent(`
  # Orchestrator

  Use orchestrator_* tools to delegate work to other AI agents (claude/codex/gemini) on this or other machines.

  Workflow:
  1. Call orchestrator_get_context first to discover available providers, models, and machines.
  2. After orchestrator_submit, wait for <orchestrator-callback> before calling orchestrator_pend with include="all_tasks".
  3. When using dependsOn, tasks are isolated and receive no upstream output. To pass data between tasks, instruct the upstream task to save results to a shared file and the downstream task to read it.
`);

export function isOrchestratorWorkerSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ORCHESTRATOR_ENV_KEYS.oneshot] === '1' || !!env[ORCHESTRATOR_ENV_KEYS.executionId];
}

export function shouldEnableOrchestratorTools(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOrchestratorWorkerSession(env);
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

export function getBaseSystemPrompt(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!shouldEnableOrchestratorTools(env)) {
    return null;
  }
  return buildFirstTurnToolingInstruction(CHAT_TITLE_INSTRUCTION, env);
}
