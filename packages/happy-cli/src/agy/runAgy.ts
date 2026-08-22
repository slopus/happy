/**
 * Agy Session Runner
 *
 * Entry point for agy (Antigravity CLI) agent sessions, following the runOpenClaw.ts
 * pattern. The daemon spawns this as:
 *   `node dist/index.mjs agy --happy-starting-mode remote --started-by daemon`
 *
 * agy is executed with `--output-format stream-json`, and this runner drives an AgyBackend
 * that maps its structured events (text deltas, tool calls, tool results, thinking) into
 * Happy's ACP Session envelopes and mobile/web UI.
 *
 * Happy session lifecycle is fully decoupled from the agy subprocess: the Happy session
 * stays alive across turns, and dynamically binds to the agy conversation ID.
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
import { createAgyBackend } from './createAgyBackend';
import { DEFAULT_AGY_MODEL } from './constants';
import { discoverAgyModels, resolveAgyModelName } from './discoverModels';
import { extractSessionTitle } from './title';
import { parseSpecialCommand } from '@/parsers/specialCommands';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  dangerouslySkipPermissions?: boolean;
  resumeConversationId?: string;
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

  const discoveredModels = await discoverAgyModels({ log });

  const initialModel = resolveAgyModelName(opts.model, discoveredModels) ?? DEFAULT_AGY_MODEL;
  const isSkipPermissions =
    opts.dangerouslySkipPermissions === true ||
    opts.permissionMode === 'bypassPermissions' ||
    opts.permissionMode === 'yolo';
  const initialPermissionMode: PermissionMode =
    opts.permissionMode ?? (isSkipPermissions ? 'bypassPermissions' : 'default');

  const initialConversationId = opts.resumeConversationId;

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    dangerouslySkipPermissions: isSkipPermissions,
  });
  metadata.models = discoveredModels.map((m) => ({
    code: m.code,
    value: m.value,
    description: m.description ?? null,
  }));
  metadata.currentModelCode = initialModel;
  if (initialConversationId) {
    metadata.agyConversationId = initialConversationId;
  }

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

  let displayedModel = initialModel;

  const backend = createAgyBackend({
    cwd: process.cwd(),
    permissionMode: initialPermissionMode,
    model: initialModel,
    models: discoveredModels,
    conversationId: initialConversationId,
    log,
    onConversationId: (cid) => {
      if (metadata.agyConversationId !== cid) {
        metadata.agyConversationId = cid;
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          agyConversationId: cid,
        }));
        log(`Persisted agy conversation ID to session metadata: ${cid}`);
      }
    },
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
    } else if (msg.type === 'tool-call') {
      messageBuffer.addMessage(`🔧 ${msg.toolName}`, 'status');
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
      const canonicalModel = resolveAgyModelName(message.meta.model, discoveredModels) ?? message.meta.model;
      backend.setModel(canonicalModel);
      displayedModel = canonicalModel;
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        currentModelCode: displayedModel,
      }));
      if (hasTTY) {
        messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
      }
    }

    const specialCommand = parseSpecialCommand(message.content.text);
    if (specialCommand.type === 'clear') {
      log('Detected /clear command');
      messageQueue.pushIsolateAndClear(message.content.text, {});
      return;
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
      await backend.cancel(sessionTag);
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

      const specialCommand = parseSpecialCommand(batch.message);
      if (specialCommand.type === 'clear') {
        log('Handling /clear command - resetting agy session');
        backend.reset();
        delete metadata.agyConversationId;
        delete metadata.summary;
        session.updateMetadata((currentMetadata) => {
          const nextMetadata = { ...currentMetadata };
          delete nextMetadata.agyConversationId;
          delete nextMetadata.summary;
          return nextMetadata;
        });
        messageBuffer.addMessage('Context was reset', 'status');
        session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
        thinking = false;
        session.keepAlive(false, 'remote');
        session.sendSessionEvent({ type: 'ready' });
        continue;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      if (!metadata.summary) {
        const title = extractSessionTitle(batch.message);
        metadata.summary = {
          text: title,
          updatedAt: Date.now(),
        };
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          summary: metadata.summary,
        }));
        log(`Generated session title: "${title}"`);
      }

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
