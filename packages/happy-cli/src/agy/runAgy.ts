/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * agy is a plain-text streaming CLI (no ACP), so this drives an AgyBackend that
 * spawns `agy --print` per turn, and forwards its AgentMessage stream through the
 * same session pipeline used by the other backends.
 */

import { randomUUID } from 'node:crypto';
import React from 'react';
import { render, type Instance as InkInstance } from 'ink';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { AgyDisplay } from '@/ui/ink/AgyDisplay';
import type { AgentMessage } from '@/agent/core';
import type { PermissionMode } from '@/api/types';
import { AgyBackend } from './AgyBackend';
import { DEFAULT_AGY_MODEL } from './constants';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
}

export async function runAgy(opts: RunAgyOptions): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend('agy');

  const log = (msg: string) => {
    logger.debug(`[agy] ${msg}`);
    if (verbose) {
      console.log(`[agy] ${msg}`);
    }
  };

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[agy] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  let shouldExit = false;
  let abortController = new AbortController();
  let thinking = false;

  let displayedModel = DEFAULT_AGY_MODEL;

  const backend = new AgyBackend({
    cwd: process.cwd(),
    permissionMode: 'default',
    model: DEFAULT_AGY_MODEL,
    log,
  });

  // Terminal UI (only with a real TTY; the daemon runs headless).
  const messageBuffer = new MessageBuffer();
  const hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let inkInstance: InkInstance | null = null;

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    if (msg.type === 'model-output' && msg.textDelta) {
      messageBuffer.addMessage(msg.textDelta, 'assistant');
    } else if (msg.type === 'status') {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'error' && msg.detail) {
        messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
      }
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  if (hasTTY) {
    const DisplayComponent = () =>
      React.createElement(AgyDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: displayedModel,
        onExit: async () => {
          logger.debug('[agy] Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        },
      });

    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false,
    });
    messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  session.onUserMessage((message) => {
    if (!message.content.text) return;

    if (message.meta?.permissionMode) {
      backend.setPermissionMode(message.meta.permissionMode as PermissionMode);
    }
    if (message.meta?.hasOwnProperty('model') && message.meta.model) {
      backend.setModel(message.meta.model);
      displayedModel = message.meta.model;
      if (hasTTY) {
        messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
      }
    }

    messageBuffer.addMessage(message.content.text, 'user');
    messageQueue.push(message.content.text, {});
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      await backend.cancel();
    } catch (error) {
      logger.debug('[agy] Abort failed:', error);
    }
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  });

  try {
    await backend.startSession();
    log('Backend ready');

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      sendEnvelopes(sessionManager.startTurn());
      try {
        await backend.sendPrompt(process.cwd(), batch.message);
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Turn ended: ${msg}`);
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();

    backend.offMessage(onBackendMessage);
    await backend.dispose();
    inkInstance?.unmount();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[agy] Session close failed:', error);
    }
  }
}
