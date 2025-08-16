/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { getDaemonState } from './utils';
import { Metadata } from '@/api/types';

async function daemonPost(path: string, body?: any): Promise<any> {
  const state = await getDaemonState();
  if (!state?.httpPort) {
    throw new Error('No daemon running');
  }

  try {
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    logger.debug(`[CONTROL CLIENT] Request failed: ${path}`, error);
    throw error;
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<void> {
  await daemonPost('/session-started', {
    sessionId,
    metadata
  });
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost('/stop-session', { sessionId });
  return result.success || false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any> {
  const result = await daemonPost('/spawn-session', { directory, sessionId });
  return result;
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}