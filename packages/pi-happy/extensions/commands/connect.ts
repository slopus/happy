import { randomUUID } from 'node:crypto';

import type { PiHappyCredentials } from '../credentials';
import { loadCredentials } from '../credentials';
import { loadConfig } from '../config';
import { loadSettings } from '../settings';
import type { PiHappySettings } from '../settings';
import { HappySessionClient } from '../happy-session-client';
import type { HappySessionClientLike } from '../offline-stub';
import { buildInitialAgentState, buildSessionMetadata, notifyDaemonSessionStarted } from '../session-lifecycle';
import { collectMetadataPatch } from '../metadata-sync';
import { registerInboundMessageBridge } from '../inbound-messages';
import type { ConnectionUIManager } from '../ui';
import { STATUS_NOT_LOGGED_IN, STATUS_DISCONNECTED } from '../ui';
import type { PiExtensionApiLike, PiHappyConfig, PiHappyExtensionContext } from '../types';
import { ConnectionState } from '../types';
import { logger } from '../../vendor/logger';

import packageJson from '../../package.json';

export interface ConnectDependencies {
  pi: PiExtensionApiLike;
  uiManager: ConnectionUIManager;
  getClient: () => HappySessionClientLike | null;
  setClient: (client: HappySessionClientLike | null) => void;
  getConfig: () => PiHappyConfig | null;
  setConfig: (config: PiHappyConfig) => void;
  getSettings: () => PiHappySettings | null;
  setSettings: (settings: PiHappySettings) => void;
  getCredentials: () => PiHappyCredentials | null;
  setCredentials: (credentials: PiHappyCredentials | null) => void;
  setAuthenticated: (value: boolean) => void;
  onClientReady: (client: HappySessionClientLike) => void;
}

/**
 * Handle /happy-disconnect: gracefully close the current Happy session
 * without clearing credentials.
 */
export async function handleDisconnectCommand(
  deps: ConnectDependencies,
  ctx: Pick<PiHappyExtensionContext, 'hasUI' | 'ui'>,
): Promise<void> {
  const client = deps.getClient();
  if (!client) {
    if (ctx.hasUI) {
      ctx.ui.notify?.('📱 Happy: No active session to disconnect', 'info');
    }
    return;
  }

  try {
    await client.updateLifecycleState('archived');
  } catch (error) {
    logger.error('failed to archive session during disconnect', error);
  }

  try {
    client.sendSessionDeath();
  } catch (error) {
    logger.error('failed to send session death during disconnect', error);
  }

  try {
    await client.flush();
  } catch (error) {
    logger.error('failed to flush during disconnect', error);
  }

  try {
    await client.close();
  } catch (error) {
    logger.error('failed to close during disconnect', error);
  }

  deps.setClient(null);
  deps.uiManager.detach();
  deps.uiManager.setStatusDirect(STATUS_DISCONNECTED);

  if (ctx.hasUI) {
    ctx.ui.notify?.('📱 Happy: Disconnected', 'info');
  }
}

/**
 * Handle /happy-connect: re-establish connection if disconnected.
 */
export async function handleConnectCommand(
  deps: ConnectDependencies,
  ctx: PiHappyExtensionContext,
): Promise<void> {
  const existingClient = deps.getClient();
  if (existingClient) {
    const state = existingClient.getConnectionState();
    if (state === ConnectionState.Connected || state === ConnectionState.Connecting) {
      if (ctx.hasUI) {
        ctx.ui.notify?.('📱 Happy: Already connected', 'info');
      }
      return;
    }
  }

  const config = loadConfig();
  deps.setConfig(config);

  const [credentials, settings] = await Promise.all([
    loadCredentials(config.happyHomeDir),
    loadSettings(config.settingsFile),
  ]);

  deps.setSettings(settings);

  if (!credentials) {
    deps.setAuthenticated(false);
    deps.uiManager.setStatusDirect(STATUS_NOT_LOGGED_IN);
    if (ctx.hasUI) {
      ctx.ui.notify?.(STATUS_NOT_LOGGED_IN, 'info');
    }
    return;
  }

  deps.setCredentials(credentials);
  deps.setAuthenticated(true);

  const metadataPatch = collectMetadataPatch(deps.pi, ctx);
  const metadata = buildSessionMetadata(ctx, config, settings, packageJson.version, metadataPatch);

  try {
    const client = await HappySessionClient.createWithOfflineFallback(
      credentials,
      {
        serverUrl: config.serverUrl,
        cwd: ctx.cwd,
        onAbort: () => ctx.abort(),
        onShutdown: () => ctx.shutdown(),
        onSessionSwap: async recovered => {
          deps.setClient(recovered);
          deps.uiManager.updateSessionId(recovered.sessionId);
          deps.uiManager.notifyReconnected();
          try {
            await notifyDaemonSessionStarted(config.daemonStateFile, recovered.sessionId, recovered.getMetadata());
          } catch (error) {
            logger.warn('failed to notify daemon after reconnect', error);
          }
        },
      },
      randomUUID(),
      metadata,
      buildInitialAgentState(),
    );

    deps.setClient(client);
    deps.uiManager.resetStats();
    deps.uiManager.attach(client);
    deps.onClientReady(client);

    registerInboundMessageBridge(client, deps.pi, ctx, {
      onSuccess: () => {
        deps.uiManager.recordReceived();
        deps.uiManager.notifyMobileMessage();
      },
    });

    try {
      await notifyDaemonSessionStarted(config.daemonStateFile, client.sessionId, client.getMetadata());
    } catch (error) {
      logger.warn('failed to notify daemon on connect', error);
    }

    if (ctx.hasUI) {
      ctx.ui.notify?.('📱 Happy: Connected', 'info');
    }
  } catch (error) {
    logger.error('failed to create Happy session during connect', error);
    if (ctx.hasUI) {
      ctx.ui.notify?.('📱 Happy: Connection failed', 'error');
    }
  }
}
