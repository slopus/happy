import type { ConnectionUIManager } from '../ui';
import { getConnectionStatusLabel } from '../ui';
import type { PiHappyConfig, PiHappyExtensionContext } from '../types';
import type { PiHappySettings } from '../settings';

export interface HappyStatusInfo {
  authenticated: boolean;
  serverUrl: string;
  sessionId: string | null;
  connectionState: string;
  messagesSent: number;
  messagesReceived: number;
  machineId: string | undefined;
  connectedSince: number | null;
}

/**
 * Gather Happy connection status information for display.
 */
export function gatherStatusInfo(
  uiManager: ConnectionUIManager | null,
  config: PiHappyConfig | null,
  settings: PiHappySettings | null,
  authenticated: boolean,
): HappyStatusInfo {
  const currentState = uiManager?.getCurrentState();
  const stats = uiManager?.stats;

  return {
    authenticated,
    serverUrl: config?.serverUrl ?? '(unknown)',
    sessionId: uiManager?.getSessionId() ?? null,
    connectionState: currentState
      ? getConnectionStatusLabel(currentState)
      : '(not started)',
    messagesSent: stats?.messagesSent ?? 0,
    messagesReceived: stats?.messagesReceived ?? 0,
    machineId: settings?.machineId,
    connectedSince: stats?.connectedSince ?? null,
  };
}

/**
 * Format status info into human-readable lines.
 */
export function formatStatusLines(info: HappyStatusInfo): string[] {
  const lines: string[] = [];

  lines.push(`Auth:       ${info.authenticated ? 'Logged in' : 'Not logged in'}`);
  lines.push(`Server:     ${info.serverUrl}`);
  lines.push(`Session:    ${info.sessionId ?? '(none)'}`);
  lines.push(`State:      ${info.connectionState}`);
  lines.push(`Messages:   sent=${info.messagesSent}, received=${info.messagesReceived}`);
  lines.push(`Machine ID: ${info.machineId ?? '(unknown)'}`);

  if (info.connectedSince !== null) {
    const since = new Date(info.connectedSince).toISOString();
    lines.push(`Connected:  ${since}`);
  }

  return lines;
}

/**
 * Handle the /happy-status command.
 */
export function handleStatusCommand(
  uiManager: ConnectionUIManager | null,
  config: PiHappyConfig | null,
  settings: PiHappySettings | null,
  authenticated: boolean,
  ctx: Pick<PiHappyExtensionContext, 'hasUI' | 'ui'>,
): void {
  const info = gatherStatusInfo(uiManager, config, settings, authenticated);
  const lines = formatStatusLines(info);
  const text = lines.join('\n');

  if (ctx.hasUI) {
    ctx.ui.notify?.(text, 'info');
  }
}
