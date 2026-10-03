import { createHash } from 'node:crypto';
import type { SandboxConfig } from '@/persistence';
import { readDaemonControlPort } from './browserClient';

export type ScopeConfirmation = { token: string; digest: string; sessionId: string };
/** Take before creating agent transports; the confirmation token stays in the parent only. */
export function takeScopeConfirmation(env: NodeJS.ProcessEnv = process.env): ScopeConfirmation | null {
  const token = env.HAPPY_WRITE_SCOPE_APPLY_TOKEN;
  const digest = env.HAPPY_WRITE_SCOPE_PROFILE_DIGEST;
  const sessionId = env.APLUS_SESSION_ID;
  for (const key of Object.keys(env)) if (key.startsWith('HAPPY_WRITE_SCOPE_') && key !== 'HAPPY_WRITE_SCOPE_SESSION') delete env[key];
  return token && digest && sessionId ? { token, digest, sessionId } : null;
}
export async function confirmSessionWriteScope(confirmation: ScopeConfirmation | null, sandboxEnabled: boolean, config: SandboxConfig | undefined): Promise<void> {
  if (!confirmation) return;
  if (!sandboxEnabled || !config || createHash('sha256').update(JSON.stringify(config)).digest('hex') !== confirmation.digest) throw new Error('SCOPE_PROFILE_NOT_PROTECTED');
  const connection = await readDaemonControlPort();
  if (!connection) throw new Error('SCOPE_DAEMON_UNAVAILABLE');
  const response = await fetch(`http://127.0.0.1:${connection.port}/session-write-scope/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.controlSecret}` },
    body: JSON.stringify({ ...confirmation, pid: process.pid }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('SCOPE_CONFIRMATION_REJECTED');
}
