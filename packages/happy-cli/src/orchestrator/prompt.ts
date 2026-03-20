import { trimIdent } from '@/utils/trimIdent';
import { ORCHESTRATOR_ENV_KEYS } from './common';

export const CHAT_TITLE_INSTRUCTION = trimIdent(`
  # Chat title

  On your first response, call "change_title" to set a descriptive title based on the user's message. Update the title whenever the conversation's main focus shifts to a different topic or task.
`);

export const ORCHESTRATOR_TOOLS_INSTRUCTION = trimIdent(`
  # Orchestrator

  Use orchestrator_* tools to delegate work to other AI agents (claude/codex/gemini) on this or other machines.
  Call orchestrator_get_context first to discover available providers, models, and machines.
  orchestrator_submit always returns immediately with a runId.
  When the run completes, you will automatically receive an <orchestrator-callback> message with the run status.
  Do NOT call orchestrator_pend right after submitting — wait for the callback first.
  After receiving the callback, call orchestrator_pend with include="all_tasks" to fetch full results.
  If no callback arrives within a reasonable time, you may call orchestrator_pend as a fallback to check status.
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
