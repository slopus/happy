/**
 * OpenCode CLI Entry Point
 *
 * Runs the OpenCode agent through Happy CLI using ACP.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/mcp/startHappyServer';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permissionModeMetadata';
import { applyStartupMetadataUpdateToSession, buildPermissionModeOverride } from '@/agent/runtime/startupMetadataUpdate';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { stopCaffeinate } from '@/integrations/caffeinate';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { OpenCodeTerminalDisplay } from '@/backends/opencode/ui/OpenCodeTerminalDisplay';

import type { McpServerConfig } from '@/agent';
import { OpenCodePermissionHandler } from './utils/permissionHandler';
import { maybeUpdateOpenCodeSessionIdMetadata } from './utils/opencodeSessionIdMetadata';
import { createOpenCodeAcpRuntime } from './acp/runtime';
import { waitForNextOpenCodeMessage } from './utils/waitForNextOpenCodeMessage';

export async function runOpenCode(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: import('@/terminal/terminalRuntimeFlags').TerminalRuntimeFlags | null;
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  existingSessionId?: string;
  resume?: string;
}): Promise<void> {
  const sessionTag = randomUUID();

  connectionState.setBackend('OpenCode');

  const api = await ApiClient.create(opts.credentials);

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings. Please report this issue on https://github.com/slopus/happy-cli/issues`);
    process.exit(1);
  }
  await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });

  const initialPermissionMode = opts.permissionMode ?? 'default';
  const { state, metadata } = createSessionMetadata({
    flavor: 'opencode',
    machineId,
    startedBy: opts.startedBy,
    terminalRuntime: opts.terminalRuntime ?? null,
    permissionMode: initialPermissionMode,
    permissionModeUpdatedAt: typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : Date.now(),
  });

  const terminal = metadata.terminal;
  let session: ApiSessionClient;
  let permissionHandler: OpenCodePermissionHandler;
  let reconnectionHandle: { cancel: () => void } | null = null;

  if (typeof opts.existingSessionId === 'string' && opts.existingSessionId.trim()) {
    const existingId = opts.existingSessionId.trim();
    logger.debug(`[opencode] Attaching to existing Happy session: ${existingId}`);
    const baseSession = await createBaseSessionForAttach({ existingSessionId: existingId, metadata, state });
    session = api.sessionSyncClient(baseSession);

    applyStartupMetadataUpdateToSession({
      session,
      next: metadata,
      nowMs: Date.now(),
      permissionModeOverride: buildPermissionModeOverride({
        permissionMode: opts.permissionMode,
        permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
      }),
    });

    primeAgentStateForUi(session, '[OpenCode]');
    await reportSessionToDaemonIfRunning({ sessionId: existingId, metadata });
    await persistTerminalAttachmentInfoIfNeeded({ sessionId: existingId, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });
  } else {
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (!response) {
      throw new Error('Failed to create session');
    }

    const { session: initialSession, reconnectionHandle: rh } = setupOfflineReconnection({
      api,
      sessionTag,
      metadata,
      state,
      response,
      onSessionSwap: (newSession) => {
        session = newSession;
        if (permissionHandler) {
          permissionHandler.updateSession(newSession);
        }
      },
    });
    session = initialSession;
    reconnectionHandle = rh;

    primeAgentStateForUi(session, '[OpenCode]');
    await reportSessionToDaemonIfRunning({ sessionId: response.id, metadata });
    await persistTerminalAttachmentInfoIfNeeded({ sessionId: response.id, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });
  }

  // Start Happy MCP server for `change_title` tool exposure (bridged to ACP via happy-mcp.mjs).
  const happyServer = await startHappyServer(session);

  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers: Record<string, McpServerConfig> = {
    happy: { command: bridgeCommand, args: ['--url', happyServer.url] },
  };

  let abortRequestedCallback: (() => void | Promise<void>) | null = null;
  permissionHandler = new OpenCodePermissionHandler(session, {
    onAbortRequested: () => abortRequestedCallback?.(),
  });
  permissionHandler.setPermissionMode(initialPermissionMode);

  // Message queue keyed by permission mode. OpenCode can apply permission decisions per tool call
  // without restarting the session, so we do not include model in the hash.
  const messageQueue = new MessageQueue2<{ permissionMode: PermissionMode }>((mode) => hashObject({
    permissionMode: mode.permissionMode,
  }));

  let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;

  session.onUserMessage((message) => {
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const nextPermissionMode = message.meta.permissionMode as PermissionMode;
      const res = maybeUpdatePermissionModeMetadata({
        currentPermissionMode,
        nextPermissionMode,
        updateMetadata: (updater) => session.updateMetadata(updater),
      });
      currentPermissionMode = res.currentPermissionMode;
      messagePermissionMode = currentPermissionMode;
    }

    const mode = { permissionMode: messagePermissionMode || 'default' };
    const special = parseSpecialCommand(message.content.text);
    if (special.type === 'clear') {
      messageQueue.pushIsolateAndClear(message.content.text, mode);
    } else {
      messageQueue.push(message.content.text, mode);
    }
  });

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;
  if (hasTTY) {
    console.clear();
    inkInstance = render(React.createElement(OpenCodeTerminalDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      onExit: async () => {
        shouldExit = true;
        await handleAbort();
      },
    }), { exitOnCtrlC: false, patchConsole: false });
  }

  let thinking = false;
  let shouldExit = false;
  let abortController = new AbortController();
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => session.keepAlive(thinking, 'remote'), 2000);

  const runtime = createOpenCodeAcpRuntime({
    directory: metadata.path,
    session,
    messageBuffer,
    mcpServers,
    permissionHandler,
    onThinkingChange: (value) => { thinking = value; },
  });
  const lastPublishedOpenCodeSessionId = { value: null as string | null };

  const handleAbort = async () => {
    logger.debug('[OpenCode] Abort requested');
    session.sendAgentMessage('opencode', { type: 'turn_aborted', id: randomUUID() });
    permissionHandler.reset();
    messageQueue.reset();
    try {
      abortController.abort();
      abortController = new AbortController();
      await runtime.cancel();
    } catch (e) {
      logger.debug('[OpenCode] Failed to cancel current operation (non-fatal)', e);
    }
  };
  abortRequestedCallback = handleAbort;

  const handleKillSession = async () => {
    logger.debug('[OpenCode] Kill session requested');
    shouldExit = true;
    await handleAbort();
    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated',
        }));
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }
    } finally {
      clearInterval(keepAliveInterval);
      reconnectionHandle?.cancel();
      stopCaffeinate();
      happyServer.stop();
      await runtime.reset();
      inkInstance?.unmount();
      process.exit(0);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices("It's ready!", 'OpenCode is waiting for your command', { sessionId: session.sessionId });
    } catch (pushError) {
      logger.debug('[OpenCode] Failed to send ready push', pushError);
    }
  };

  let wasStarted = false;
  let storedSessionIdForResume: string | null = null;
  if (typeof opts.resume === 'string' && opts.resume.trim()) {
    storedSessionIdForResume = opts.resume.trim();
  }

  try {
    let currentModeHash: string | null = null;
    type QueuedMessage = { message: string; mode: { permissionMode: PermissionMode }; hash: string };
    let pending: QueuedMessage | null = null;

    while (!shouldExit) {
      let message: QueuedMessage | null = pending;
      pending = null;

      if (!message) {
        const next = await waitForNextOpenCodeMessage({
          messageQueue,
          abortSignal: abortController.signal,
          session,
        });
        if (!next) continue;
        message = { message: next.message, mode: next.mode, hash: next.hash };
      }
      if (!message) continue;

      // Apply permission mode immediately (no session restart required).
      permissionHandler.setPermissionMode(message.mode.permissionMode);

      if (currentModeHash && message.hash !== currentModeHash) {
        // Mode changes in OpenCode do not require restart; only update handler state.
        currentModeHash = message.hash;
      } else {
        currentModeHash = message.hash;
      }

      messageBuffer.addMessage(message.message, 'user');

      const special = parseSpecialCommand(message.message);
      if (special.type === 'clear') {
        messageBuffer.addMessage('Resetting OpenCode session…', 'status');
        await runtime.reset();
        wasStarted = false;
        lastPublishedOpenCodeSessionId.value = null;
        permissionHandler.reset();
        thinking = false;
        session.keepAlive(thinking, 'remote');
        messageBuffer.addMessage('Session reset.', 'status');
        sendReady();
        continue;
      }

      try {
        runtime.beginTurn();
        if (!wasStarted) {
          const resumeId = storedSessionIdForResume?.trim();
          if (resumeId) {
            storedSessionIdForResume = null; // consume once
            messageBuffer.addMessage('Resuming previous context…', 'status');
            try {
              await runtime.startOrLoad({ resumeId });
            } catch (e) {
              logger.debug('[OpenCode] Resume failed; starting a new session instead', e);
              messageBuffer.addMessage('Resume failed; starting a new session.', 'status');
              session.sendAgentMessage('opencode', { type: 'message', message: 'Resume failed; starting a new session.' });
              await runtime.startOrLoad({});
            }
          } else {
            await runtime.startOrLoad({});
          }
          maybeUpdateOpenCodeSessionIdMetadata({
            getOpenCodeSessionId: () => runtime.getSessionId(),
            updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
            lastPublished: lastPublishedOpenCodeSessionId,
          });
          wasStarted = true;
        }
        await runtime.sendPrompt(message.message);
      } catch (error) {
        logger.debug('[OpenCode] Error during prompt:', error);
        session.sendAgentMessage('opencode', { type: 'message', message: `Error: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        runtime.flushTurn();
        thinking = false;
        session.keepAlive(thinking, 'remote');
        sendReady();
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    stopCaffeinate();
    happyServer.stop();
    await runtime.reset();
    inkInstance?.unmount();
  }
}
