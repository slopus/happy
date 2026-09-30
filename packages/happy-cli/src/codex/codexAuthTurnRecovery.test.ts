import { expect, it, vi } from 'vitest';
import { CodexAuthTurnRecovery, isCodexCredentialFailure, runTurnWithCredentialRecovery } from './codexAuthTurnRecovery';

it('recognizes provider credential revocation without treating ordinary failures as login failures', () => {
  expect(isCodexCredentialFailure({ code: 'unauthorized', message: 'expired' })).toBe(true);
  expect(isCodexCredentialFailure('Your access token could not be refreshed because your refresh token was revoked.')).toBe(true);
  expect(isCodexCredentialFailure({ code: 'permission_denied', message: 'approval denied' })).toBe(false);
});

it('retries the original message in the same thread after a credential arrives', async () => {
  const sendTurn = vi.fn(async (_prompt: string, attempt: CodexAuthTurnRecovery) => {
    if (sendTurn.mock.calls.length === 1) {
      attempt.observe({ type: 'task_complete', status: 'failed', error: { code: 'unauthorized' } });
      return { aborted: true };
    }
    return { aborted: false };
  });
  const reconnect = vi.fn().mockResolvedValue(true);
  const waitForNewCredential = vi.fn().mockResolvedValue(true);
  expect(await runTurnWithCredentialRecovery({
    prompt: 'original', sendTurn, recovery: { waitForNewCredential }, reconnect,
    onWaiting: vi.fn(), onResumed: vi.fn(), onWaitController: vi.fn(), shouldExit: () => false,
  })).toEqual({ aborted: false });
  expect(sendTurn.mock.calls.map(call => call[0])).toEqual(['original', 'original']);
  expect(reconnect).toHaveBeenCalledOnce();
});

it('continues after visible work instead of replaying the original operation', async () => {
  const sendTurn = vi.fn(async (_prompt: string, attempt: CodexAuthTurnRecovery, _continuing: boolean) => {
    if (sendTurn.mock.calls.length === 1) {
      attempt.observe({ type: 'exec_command_begin', command: 'write something' });
      attempt.observe({ type: 'turn_aborted', status: 'failed', error: { message: 'unauthorized' } });
      return { aborted: true };
    }
    return { aborted: false };
  });
  await runTurnWithCredentialRecovery({
    prompt: 'original', sendTurn, recovery: { waitForNewCredential: vi.fn().mockResolvedValue(true) },
    reconnect: vi.fn().mockResolvedValue(true), onWaiting: vi.fn(), onResumed: vi.fn(),
    onWaitController: vi.fn(), shouldExit: () => false,
  });
  expect(sendTurn.mock.calls[1][0]).toContain('继续上一条');
  expect(sendTurn.mock.calls[1][0]).not.toBe('original');
  expect(sendTurn.mock.calls[1][2]).toBe(true);
});

it('stops a pending retry when the user cancels', async () => {
  let cancelled = false;
  const sendTurn = vi.fn(async (_prompt: string, attempt: CodexAuthTurnRecovery) => {
    attempt.observe({ type: 'task_complete', status: 'failed', error: 'unauthorized' });
    return { aborted: true };
  });
  const waitForNewCredential = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
    cancelled = signal.aborted;
    return false;
  });
  expect(await runTurnWithCredentialRecovery({
    prompt: 'original', sendTurn, recovery: { waitForNewCredential }, reconnect: vi.fn(),
    onWaiting: vi.fn(), onResumed: vi.fn(), onWaitController: controller => controller?.abort(),
    shouldExit: () => false,
  })).toEqual({ aborted: true });
  expect(cancelled).toBe(true);
  expect(sendTurn).toHaveBeenCalledOnce();
});
