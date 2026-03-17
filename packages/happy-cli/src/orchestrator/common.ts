export const ORCHESTRATOR_PROVIDERS = ['claude', 'codex', 'gemini'] as const;

export type OrchestratorProvider = (typeof ORCHESTRATOR_PROVIDERS)[number];

export type OrchestratorFinishStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export type OrchestratorDispatchPayload = {
  executionId: string;
  runId: string;
  taskId: string;
  dispatchToken: string;
  provider: OrchestratorProvider;
  prompt: string;
  timeoutMs: number;
  workingDirectory?: string;
};

export type OrchestratorCancelPayload = {
  executionId: string;
  runId: string;
  taskId: string;
  dispatchToken: string;
};

export type OrchestratorFinishReason = {
  watchdogTriggered: boolean;
  cancelRequested: boolean;
  exitCode: number | null;
};

export const ORCHESTRATOR_ENV_KEYS = {
  oneshot: 'HAPPY_ORCH_ONESHOT',
  executionId: 'HAPPY_ORCH_EXECUTION_ID',
  runId: 'HAPPY_ORCH_RUN_ID',
  taskId: 'HAPPY_ORCH_TASK_ID',
  promptB64: 'HAPPY_ORCH_PROMPT_B64',
  timeoutMs: 'HAPPY_ORCH_TIMEOUT_MS',
  workingDirectory: 'HAPPY_ORCH_WORKING_DIRECTORY',
} as const;

export function isOrchestratorProvider(value: unknown): value is OrchestratorProvider {
  return typeof value === 'string' && (ORCHESTRATOR_PROVIDERS as readonly string[]).includes(value);
}

export function mapFinishStatus(reason: OrchestratorFinishReason): OrchestratorFinishStatus {
  if (reason.watchdogTriggered) {
    return 'timeout';
  }
  if (reason.cancelRequested) {
    return 'cancelled';
  }
  if (reason.exitCode === 0) {
    return 'completed';
  }
  return 'failed';
}

export function encodePromptToBase64(prompt: string): string {
  return Buffer.from(prompt, 'utf8').toString('base64');
}

export function decodePromptFromBase64(promptB64: string): string {
  return Buffer.from(promptB64, 'base64').toString('utf8');
}

export function buildOrchestratorEnv(payload: OrchestratorDispatchPayload): Record<string, string> {
  const env: Record<string, string> = {
    [ORCHESTRATOR_ENV_KEYS.oneshot]: '1',
    [ORCHESTRATOR_ENV_KEYS.executionId]: payload.executionId,
    [ORCHESTRATOR_ENV_KEYS.runId]: payload.runId,
    [ORCHESTRATOR_ENV_KEYS.taskId]: payload.taskId,
    [ORCHESTRATOR_ENV_KEYS.promptB64]: encodePromptToBase64(payload.prompt),
    [ORCHESTRATOR_ENV_KEYS.timeoutMs]: String(payload.timeoutMs),
  };
  if (payload.workingDirectory) {
    env[ORCHESTRATOR_ENV_KEYS.workingDirectory] = payload.workingDirectory;
  }
  return env;
}

export function appendOutputChunk(current: string, chunk: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  const combined = `${current}${chunk}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

export function buildOutputSummary(stdout: string, stderr: string, maxChars: number = 400): string | null {
  const source = stdout.trim() ? stdout : stderr;
  if (!source.trim()) {
    return null;
  }

  const lastLine = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? source.trim();

  if (lastLine.length <= maxChars) {
    return lastLine;
  }
  return `${lastLine.slice(0, maxChars - 3)}...`;
}
