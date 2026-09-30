import type { EventMsg } from './codexAppServerTypes';

/** 仅在上游凭证失效时等待并重试回合。 */
export function isCodexCredentialFailure(value: unknown): boolean {
  const error = value instanceof Error ? { message: value.message } : value;
  if (typeof error === 'string') return /refresh token was revoked|access token could not be refreshed|invalid_grant|\bunauthorized\b/i.test(error);
  if (!error || typeof error !== 'object') return false;
  const detail = error as Record<string, unknown>;
  if (typeof detail.code === 'string' && /^(unauthorized|invalid_grant)$/i.test(detail.code)) return true;
  return typeof detail.message === 'string' && isCodexCredentialFailure(detail.message);
}

/** 记录已发生的输出和工具操作，避免重放带副作用的回合。 */
export class CodexAuthTurnRecovery {
  private activity = false;
  private credentialFailure = false;

  observe(event: EventMsg): void {
    if ((event.type === 'task_complete' || event.type === 'turn_aborted') &&
      (event.status === 'failed' || event.error != null) && isCodexCredentialFailure(event.error)) {
      this.credentialFailure = true;
    }
    if (event.type === 'agent_message' || event.type === 'agent_reasoning' ||
      /(?:exec_command|patch_apply|mcp_tool_call|collab_agent_tool|web_search|tool_call)_begin$/.test(event.type)) {
      this.activity = true;
    }
  }

  observeText(): void { this.activity = true; }
  observeError(error: unknown): void { if (isCodexCredentialFailure(error)) this.credentialFailure = true; }
  get needsCredential(): boolean { return this.credentialFailure; }
  get hasActivity(): boolean { return this.activity; }
}

export async function runTurnWithCredentialRecovery(options: {
  prompt: string;
  sendTurn: (prompt: string, attempt: CodexAuthTurnRecovery, continuing: boolean) => Promise<{ aborted: boolean }>;
  recovery?: { waitForNewCredential(options: { signal: AbortSignal; onWaiting: () => void }): Promise<boolean> };
  reconnect: () => Promise<boolean>;
  onWaiting: () => void;
  onResumed: () => void;
  onWaitController: (controller: AbortController | undefined) => void;
  shouldExit: () => boolean;
}): Promise<{ aborted: boolean }> {
  let prompt = options.prompt;
  let continuing = false;
  while (!options.shouldExit()) {
    const attempt = new CodexAuthTurnRecovery();
    let result: { aborted: boolean } | undefined;
    let error: unknown;
    try { result = await options.sendTurn(prompt, attempt, continuing); }
    catch (caught) { error = caught; attempt.observeError(caught); }
    if (!attempt.needsCredential || !options.recovery) {
      if (error) throw error;
      return result ?? { aborted: true };
    }
    if (options.shouldExit()) return { aborted: true };
    const controller = new AbortController();
    options.onWaitController(controller);
    try {
      const refreshed = await options.recovery.waitForNewCredential({ signal: controller.signal, onWaiting: options.onWaiting });
      if (!refreshed || options.shouldExit()) return { aborted: true };
      if (!await options.reconnect()) throw new Error('Codex could not resume the original thread after credential refresh');
      if (attempt.hasActivity) {
        prompt = '请在当前会话继续上一条因 Codex 认证失效而中断的任务。先检查已有输出和工具结果，不要重复已经完成的操作。';
        continuing = true;
      }
      options.onResumed();
    } finally { options.onWaitController(undefined); }
  }
  return { aborted: true };
}
