import { randomUUID } from 'node:crypto';

import type { SessionEnvelope, SessionTurnEndStatus } from '@slopus/happy-wire';

import packageJson from '../package.json';
import { loadConfig } from './config';
import type { PiHappyCredentials } from './credentials';
import { loadCredentials } from './credentials';
import { PiSessionMapper } from './event-mapper';
import { HappySessionClient } from './happy-session-client';
import { registerInboundMessageBridge } from './inbound-messages';
import { collectMetadataPatch, syncModelSelection } from './metadata-sync';
import type { HappySessionClientLike } from './offline-stub';
import type { PiHappySettings } from './settings';
import { loadSettings } from './settings';
import {
  buildInitialAgentState,
  buildSessionMetadata,
  notifyDaemonSessionStarted,
  startKeepAliveLoop,
  stopKeepAliveLoop,
  type PiHappyRuntimeSession,
} from './session-lifecycle';
import {
  ConnectionState,
  type PiExtensionApiLike,
  type PiHappyConfig,
  type PiHappyEventMap,
  type PiHappyExtensionContext,
  type PiHappyTurnEndEvent,
} from './types';
import {
  ConnectionUIManager,
  STATUS_CONNECTED,
  STATUS_DISCONNECTED,
  STATUS_NOT_LOGGED_IN,
  STATUS_OFFLINE,
  NOTIFICATION_SYNC_FAILING,
} from './ui';
import { handleStatusCommand } from './commands/status';
import { handleDisconnectCommand, handleConnectCommand, type ConnectDependencies } from './commands/connect';
import { logger } from '../vendor/logger';

// Re-export for backward-compat with existing tests
export { STATUS_CONNECTED as PI_HAPPY_CONNECTED_STATUS } from './ui';
export { STATUS_RECONNECTING as PI_HAPPY_CONNECTING_STATUS } from './ui';
export { STATUS_OFFLINE as PI_HAPPY_OFFLINE_STATUS } from './ui';
export { STATUS_DISCONNECTED as PI_HAPPY_DISCONNECTED_STATUS } from './ui';
export { STATUS_NOT_LOGGED_IN as PI_HAPPY_NOT_LOGGED_IN_STATUS } from './ui';
export { NOTIFICATION_SYNC_FAILING as PI_HAPPY_SYNC_FAILING_NOTIFICATION } from './ui';
export { PI_HAPPY_STATUS_KEY } from './ui';
export { getConnectionStatusLabel } from './ui';

type BridgeRuntime = PiHappyRuntimeSession & {
  client: HappySessionClientLike | null;
  mapper: PiSessionMapper | null;
  uiManager: ConnectionUIManager | null;
  config: PiHappyConfig | null;
  settings: PiHappySettings | null;
  credentials: PiHappyCredentials | null;
  authenticated: boolean;
  consecutiveFailures: number;
  failureWarningShown: boolean;
  notifiedSessionIds: Set<string>;
  disabled: boolean;
  lastCtx: PiHappyExtensionContext | null;
};

function createRuntime(): BridgeRuntime {
  return {
    client: null,
    mapper: null,
    uiManager: null,
    config: null,
    settings: null,
    credentials: null,
    authenticated: false,
    keepAliveTimer: null,
    thinking: false,
    consecutiveFailures: 0,
    failureWarningShown: false,
    notifiedSessionIds: new Set<string>(),
    disabled: false,
    lastCtx: null,
  };
}

function notifyFailureOnce(runtime: BridgeRuntime): void {
  if (runtime.failureWarningShown) {
    return;
  }

  runtime.uiManager?.notifySyncFailing();
  runtime.failureWarningShown = true;
}

function recordFailure(
  runtime: BridgeRuntime,
  eventName: string,
  error: unknown,
): void {
  runtime.consecutiveFailures += 1;
  logger.error(`failed handling ${eventName}`, error);
  if (runtime.consecutiveFailures >= 10) {
    notifyFailureOnce(runtime);
  }
}

function clearFailures(runtime: BridgeRuntime): void {
  runtime.consecutiveFailures = 0;
}

async function executeSafely(
  runtime: BridgeRuntime,
  ctx: Pick<PiHappyExtensionContext, 'hasUI' | 'ui'>,
  eventName: string,
  handler: () => Promise<void> | void,
  options: { clearOnSuccess?: boolean } = {},
): Promise<void> {
  try {
    await handler();
    if (options.clearOnSuccess ?? true) {
      clearFailures(runtime);
    }
  } catch (error) {
    recordFailure(runtime, eventName, error);
  }
}

function sendEnvelopes(runtime: BridgeRuntime, envelopes: SessionEnvelope[]): void {
  if (!runtime.client || envelopes.length === 0) {
    return;
  }

  for (const envelope of envelopes) {
    runtime.client.sendSessionProtocolMessage(envelope);
    runtime.uiManager?.recordSent();
  }
}

function isOfflineSessionId(sessionId: string): boolean {
  return sessionId.startsWith('offline-');
}

function isAssistantMessage(value: unknown): value is { role: 'assistant'; stopReason?: string; content?: unknown[] } {
  return !!value && typeof value === 'object' && (value as { role?: unknown }).role === 'assistant';
}

function hasStringDelta(
  event: { type: string; delta?: unknown },
  type: 'text_delta' | 'thinking_delta',
): event is { type: typeof type; delta: string } {
  return event.type === type && typeof event.delta === 'string';
}

function isCancelledTurn(event: PiHappyTurnEndEvent, ctx: Pick<PiHappyExtensionContext, 'isIdle'>): boolean {
  if (isAssistantMessage(event.message) && event.message.stopReason === 'aborted') {
    return true;
  }

  return ctx.isIdle()
    && event.toolResults.length === 0
    && isAssistantMessage(event.message)
    && Array.isArray(event.message.content)
    && event.message.content.length === 0;
}

export function inferTurnEndStatus(
  event: PiHappyTurnEndEvent,
  ctx: Pick<PiHappyExtensionContext, 'isIdle'>,
): SessionTurnEndStatus {
  return isCancelledTurn(event, ctx) ? 'cancelled' : 'completed';
}

async function maybeNotifyDaemon(runtime: BridgeRuntime, daemonStateFile: string): Promise<void> {
  const client = runtime.client;
  if (!client) {
    return;
  }

  const sessionId = client.sessionId;
  if (isOfflineSessionId(sessionId) || runtime.notifiedSessionIds.has(sessionId)) {
    return;
  }

  try {
    const notified = await notifyDaemonSessionStarted(daemonStateFile, sessionId, client.getMetadata());
    if (notified) {
      runtime.notifiedSessionIds.add(sessionId);
    }
  } catch (error) {
    logger.warn('failed to notify Happy daemon about session start', error);
  }
}

async function shutdownActiveSession(runtime: BridgeRuntime, ctx?: PiHappyExtensionContext): Promise<void> {
  stopKeepAliveLoop(runtime);

  const client = runtime.client;
  const mapper = runtime.mapper;
  runtime.client = null;
  runtime.mapper = null;
  runtime.thinking = false;

  if (!client) {
    runtime.uiManager?.detach();
    if (ctx) {
      runtime.uiManager?.setStatusDirect(STATUS_DISCONNECTED);
    }
    return;
  }

  if (mapper) {
    try {
      sendEnvelopes({ ...runtime, client }, mapper.flush());
    } catch (error) {
      logger.error('failed to flush pending mapper output during shutdown', error);
    }
  }

  try {
    await client.updateLifecycleState('archived');
  } catch (error) {
    logger.error('failed to archive Happy session metadata', error);
  }

  try {
    client.sendSessionDeath();
  } catch (error) {
    logger.error('failed to send Happy session death event', error);
  }

  try {
    await client.flush();
  } catch (error) {
    logger.error('failed to flush Happy session client', error);
  }

  try {
    await client.close();
  } catch (error) {
    logger.error('failed to close Happy session client', error);
  }

  runtime.uiManager?.detach();
  if (ctx) {
    runtime.uiManager?.setStatusDirect(STATUS_DISCONNECTED);
  }
}

async function handleSessionStart(
  pi: PiExtensionApiLike,
  runtime: BridgeRuntime,
  _event: PiHappyEventMap['session_start'] | PiHappyEventMap['session_switch'],
  ctx: PiHappyExtensionContext,
): Promise<void> {
  logger.info('pi-happy loaded');
  await shutdownActiveSession(runtime);

  // Store ctx for commands that need it later
  runtime.lastCtx = ctx;

  // Initialize UI manager if not yet created
  if (!runtime.uiManager) {
    runtime.uiManager = new ConnectionUIManager(ctx.hasUI, ctx.ui);
  }

  const config = loadConfig();
  runtime.config = config;

  const [credentials, settings] = await Promise.all([
    loadCredentials(config.happyHomeDir),
    loadSettings(config.settingsFile),
  ]);

  runtime.settings = settings;

  if (!credentials) {
    runtime.authenticated = false;
    runtime.uiManager.setStatusDirect(STATUS_NOT_LOGGED_IN);
    return;
  }

  runtime.credentials = credentials;
  runtime.authenticated = true;

  const metadataPatch = collectMetadataPatch(pi, ctx);
  const metadata = buildSessionMetadata(ctx, config, settings, packageJson.version, metadataPatch);
  const mapper = new PiSessionMapper();

  const client = await HappySessionClient.createWithOfflineFallback(
    credentials,
    {
      serverUrl: config.serverUrl,
      cwd: ctx.cwd,
      onAbort: () => ctx.abort(),
      onShutdown: () => ctx.shutdown(),
      onSessionSwap: async recovered => {
        runtime.client = recovered;
        runtime.uiManager?.updateSessionId(recovered.sessionId);
        runtime.uiManager?.notifyReconnected();
        await maybeNotifyDaemon(runtime, config.daemonStateFile);
      },
    },
    randomUUID(),
    metadata,
    buildInitialAgentState(),
  );

  runtime.client = client;
  runtime.mapper = mapper;
  runtime.thinking = false;
  runtime.notifiedSessionIds.clear();
  runtime.failureWarningShown = false;

  // Attach UI manager to track connection state + render widget
  runtime.uiManager.resetStats();
  runtime.uiManager.attach(client);

  client.on('error', error => {
    void executeSafely(runtime, ctx, 'client.error', () => {
      logger.error('Happy session client error', error);
    }, { clearOnSuccess: false });
  });

  registerInboundMessageBridge(client, pi, ctx, {
    onSuccess: () => {
      clearFailures(runtime);
      runtime.uiManager?.recordReceived();
    },
    onError: error => {
      recordFailure(runtime, 'client.userMessage', error);
    },
  });

  startKeepAliveLoop(runtime, () => {
    runtime.client?.keepAlive(runtime.thinking, 'local');
  });

  await maybeNotifyDaemon(runtime, config.daemonStateFile);

  // The UI manager handles initial status via attach(), but we may need to
  // override for the offline case.
  if (client.getConnectionState() === ConnectionState.Offline) {
    runtime.uiManager.setStatusDirect(STATUS_OFFLINE);
  }
}

export default function piHappyExtension(pi: PiExtensionApiLike): void {
  const runtime = createRuntime();

  // ---------------------------------------------------------------------------
  // Flag: --no-happy
  // ---------------------------------------------------------------------------
  pi.registerFlag('no-happy', {
    description: 'Disable Happy sync',
    type: 'boolean',
    default: false,
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  function buildConnectDeps(ctx: PiHappyExtensionContext): ConnectDependencies {
    return {
      pi,
      uiManager: runtime.uiManager!,
      getClient: () => runtime.client,
      setClient: (c) => { runtime.client = c; },
      getConfig: () => runtime.config,
      setConfig: (c) => { runtime.config = c; },
      getSettings: () => runtime.settings,
      setSettings: (s) => { runtime.settings = s; },
      getCredentials: () => runtime.credentials,
      setCredentials: (c) => { runtime.credentials = c; },
      setAuthenticated: (v) => { runtime.authenticated = v; },
      onClientReady: (client) => {
        client.on('error', error => {
          logger.error('Happy session client error', error);
        });

        startKeepAliveLoop(runtime, () => {
          runtime.client?.keepAlive(runtime.thinking, 'local');
        });
      },
    };
  }

  pi.registerCommand('happy-status', {
    description: 'Show Happy connection status',
    handler: async (_args, ctx) => {
      handleStatusCommand(
        runtime.uiManager,
        runtime.config,
        runtime.settings,
        runtime.authenticated,
        ctx,
      );
    },
  });

  pi.registerCommand('happy-disconnect', {
    description: 'Disconnect from Happy without clearing credentials',
    handler: async (_args, ctx) => {
      if (!runtime.uiManager) {
        runtime.uiManager = new ConnectionUIManager(ctx.hasUI, ctx.ui);
      }

      await handleDisconnectCommand(buildConnectDeps(ctx), ctx);
      stopKeepAliveLoop(runtime);
      runtime.mapper = null;
    },
  });

  pi.registerCommand('happy-connect', {
    description: 'Re-establish Happy connection',
    handler: async (_args, ctx) => {
      if (runtime.disabled) {
        if (ctx.hasUI) {
          ctx.ui.notify?.('📱 Happy: Disabled via --no-happy flag', 'info');
        }
        return;
      }

      if (!runtime.uiManager) {
        runtime.uiManager = new ConnectionUIManager(ctx.hasUI, ctx.ui);
      }

      await handleConnectCommand(buildConnectDeps(ctx), ctx);
      runtime.mapper = new PiSessionMapper();
    },
  });

  // ---------------------------------------------------------------------------
  // Safe event handler registration
  // ---------------------------------------------------------------------------

  const registerSafeHandler = <K extends keyof PiHappyEventMap>(
    eventName: K,
    handler: (event: PiHappyEventMap[K], ctx: PiHappyExtensionContext) => Promise<void> | void,
  ): void => {
    pi.on(eventName, async (event, ctx) => {
      await executeSafely(runtime, ctx, eventName, () => handler(event, ctx));
    });
  };

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  registerSafeHandler('session_start', async (event, ctx) => {
    // Check --no-happy flag
    if (pi.getFlag('no-happy') === true) {
      runtime.disabled = true;
      logger.info('pi-happy disabled via --no-happy flag');
      return;
    }
    runtime.disabled = false;

    await handleSessionStart(pi, runtime, event, ctx);
  });

  registerSafeHandler('session_switch', async (event, ctx) => {
    if (runtime.disabled) {
      return;
    }

    await handleSessionStart(pi, runtime, event, ctx);
  });

  registerSafeHandler('session_shutdown', async (_event, ctx) => {
    if (runtime.disabled) {
      return;
    }

    await shutdownActiveSession(runtime, ctx);
  });

  // ---------------------------------------------------------------------------
  // Agent events
  // ---------------------------------------------------------------------------

  registerSafeHandler('agent_start', async (_event, _ctx) => {
    runtime.thinking = true;
    runtime.client?.keepAlive(true, 'local');
  });

  registerSafeHandler('agent_end', async (_event, _ctx) => {
    runtime.thinking = false;
    runtime.client?.keepAlive(false, 'local');
  });

  // ---------------------------------------------------------------------------
  // Turn events
  // ---------------------------------------------------------------------------

  registerSafeHandler('turn_start', async (_event, _ctx) => {
    if (!runtime.mapper) {
      return;
    }

    sendEnvelopes(runtime, runtime.mapper.startTurn());
  });

  registerSafeHandler('turn_end', async (event, ctx) => {
    if (!runtime.mapper) {
      return;
    }

    sendEnvelopes(runtime, runtime.mapper.endTurn(inferTurnEndStatus(event, ctx)));
  });

  // ---------------------------------------------------------------------------
  // Message streaming
  // ---------------------------------------------------------------------------

  registerSafeHandler('message_update', async (event, _ctx) => {
    if (!runtime.mapper) {
      return;
    }

    const assistantEvent = event.assistantMessageEvent;
    if (hasStringDelta(assistantEvent, 'text_delta')) {
      sendEnvelopes(runtime, runtime.mapper.mapTextDelta(assistantEvent.delta));
      return;
    }

    if (hasStringDelta(assistantEvent, 'thinking_delta')) {
      sendEnvelopes(runtime, runtime.mapper.mapThinkingDelta(assistantEvent.delta));
    }
  });

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  registerSafeHandler('tool_execution_start', async (event, _ctx) => {
    if (!runtime.mapper) {
      return;
    }

    sendEnvelopes(runtime, runtime.mapper.mapToolStart(event.toolCallId, event.toolName, event.args));
  });

  registerSafeHandler('tool_execution_end', async (event, _ctx) => {
    if (!runtime.mapper) {
      return;
    }

    sendEnvelopes(runtime, runtime.mapper.mapToolEnd(event.toolCallId));
  });

  // ---------------------------------------------------------------------------
  // Model selection
  // ---------------------------------------------------------------------------

  registerSafeHandler('model_select', async (event, _ctx) => {
    if (!runtime.client) {
      return;
    }

    await syncModelSelection(runtime.client, event);
  });
}
