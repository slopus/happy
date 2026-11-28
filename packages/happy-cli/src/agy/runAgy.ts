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
import { normalizeRemotePermissionMode } from '@/claude/utils/permissionMode';
import { createSerialAsyncHandler } from '@/codex/utils/serialAsyncHandler';
import type { PermissionMode, UserMessage } from '@/api/types';
import { AgyBackend } from './AgyBackend';
import {
  DEFAULT_AGY_EFFORT,
  DEFAULT_AGY_MODEL,
  FALLBACK_AGY_MODEL_OPTIONS,
  discoverAgyModelOptions,
  normalizeAgyEffort,
  normalizeAgyModelAlias,
  pickDefaultAgyModel,
  resolveAgyModelName,
} from './constants';
import {
  cleanupAgyImageCacheDir,
  downloadAgyFileEventAttachment,
  prepareAgyImagePrompt,
} from './imageInput';

export interface RunAgyOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
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

  let selectedModel = opts.model ? normalizeAgyModelAlias(opts.model) : DEFAULT_AGY_MODEL;
  let selectedEffort = opts.effort ? normalizeAgyEffort(opts.effort) : DEFAULT_AGY_EFFORT;
  let displayedModel = resolveAgyModelName(selectedModel, selectedEffort);
  // Started now, answered after the session is up: `agy models` can take seconds.
  const modelDiscovery = discoverAgyModelOptions();
  let availableModels = [...FALLBACK_AGY_MODEL_OPTIONS];

  const { state, metadata } = createSessionMetadata({
    flavor: 'agy',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
  });
  metadata.models = availableModels;
  metadata.currentModelCode = selectedModel;
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
  let errorReportedForCurrentTurn = false;

  const backend = new AgyBackend({
    cwd: process.cwd(),
    permissionMode: opts.permissionMode ?? 'default',
    model: selectedModel,
    effort: selectedEffort,
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

    const envelopes = sessionManager.mapMessage(msg);
    sendEnvelopes(envelopes);
    if (msg.type === 'status' && msg.status === 'error' && envelopes.length === 0) {
      session.sendSessionEvent({
        type: 'message',
        message: `Antigravity error: ${msg.detail?.trim() || 'The agent stopped because of an unknown error.'}`,
      });
    }
    if (msg.type === 'status' && msg.status === 'error') {
      errorReportedForCurrentTurn = true;
    }
  };

  backend.onMessage(onBackendMessage);

  let availableModelCodes = availableModels.map((item) => item.code);
  let lastRemoteModel: string | undefined = undefined;
  let lastRemoteEffort: string | null | undefined = undefined;

  const publishModelMetadata = () => {
    try {
      session.updateMetadata((curr) => ({
        ...curr,
        models: availableModels,
        currentModelCode: selectedModel,
      }));
    } catch {
      // Ignore metadata update race before first flush.
    }
  };

  const syncDisplayedModel = (nextModel: string, nextEffort?: string) => {
    selectedModel = normalizeAgyModelAlias(nextModel);
    if (nextEffort !== undefined) {
      selectedEffort = normalizeAgyEffort(nextEffort);
      backend.setEffort(selectedEffort);
    }
    backend.setModel(selectedModel);
    displayedModel = resolveAgyModelName(selectedModel, selectedEffort);
    if (hasTTY) {
      messageBuffer.addMessage(`[MODEL:${displayedModel}]`, 'system');
    }
    publishModelMetadata();
  };

  const DisplayComponent = () =>
    React.createElement(AgyDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
      currentModel: displayedModel,
      availableModels: availableModelCodes,
      onSelectModel: (chosen: string) => {
        syncDisplayedModel(chosen);
        messageBuffer.addMessage(`Switched model to ${displayedModel}`, 'status');
      },
      onExit: async () => {
        logger.debug('[agy] Exiting agent via Ctrl-C');
        shouldExit = true;
        await handleAbort();
      },
    });

  if (hasTTY) {
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

  // The default model is swapped when the account doesn't list it, even when
  // an app sent it: the app's own default is the same model, picked before
  // this list reached it. Only `--model` is left alone.
  const modelsReady = modelDiscovery.then((discovered) => {
    if (!discovered) return;
    availableModels = discovered;
    availableModelCodes = discovered.map((item) => item.code);
    const fallback = pickDefaultAgyModel(availableModelCodes);
    if (!opts.model && selectedModel === DEFAULT_AGY_MODEL && fallback !== selectedModel) {
      log(`${selectedModel} is not in agy models; defaulting to ${fallback}`);
      syncDisplayedModel(fallback);
    } else {
      publishModelMetadata();
    }
    inkInstance?.rerender(React.createElement(DisplayComponent));
  }).catch((error) => {
    logger.debug('[agy] Applying agy models failed:', error);
  });

  session.onFileEvent((fileEvent) => {
    const ev = fileEvent.content.data.ev;
    logger.debug('[agy] File event received', {
      size: ev.size,
      hasMimeType: Boolean(ev.mimeType),
    });
    session.trackAttachmentDownload(downloadAgyFileEventAttachment(session, fileEvent));
  });

  const handleUserMessage = createSerialAsyncHandler<UserMessage>(async (message) => {
    const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();
    const userText = message.content.text ?? '';
    if (!userText && attachmentsForThisMessage.length === 0) return;

    if (message.meta?.permissionMode) {
      const mode = normalizeRemotePermissionMode(message.meta.permissionMode);
      if (mode) {
        backend.setPermissionMode(mode);
      }
    }

    const incomingModel = message.meta?.hasOwnProperty('model') ? message.meta.model : undefined;
    const incomingEffort = message.meta?.hasOwnProperty('effort') ? message.meta.effort : undefined;
    const remoteModelChanged = incomingModel && incomingModel !== lastRemoteModel;
    const remoteEffortChanged = incomingEffort !== undefined && incomingEffort !== lastRemoteEffort;

    if (incomingModel !== undefined) {
      lastRemoteModel = incomingModel ?? undefined;
    }
    if (incomingEffort !== undefined) {
      lastRemoteEffort = incomingEffort;
    }

    if (remoteModelChanged || remoteEffortChanged) {
      const nextModel = incomingModel ? normalizeAgyModelAlias(incomingModel) : selectedModel;
      const nextEffort = incomingEffort !== undefined ? normalizeAgyEffort(incomingEffort) : selectedEffort;
      syncDisplayedModel(nextModel, nextEffort);
    }

    const trimmedText = userText.trim();
    if (attachmentsForThisMessage.length === 0 && /^\/models$/i.test(trimmedText)) {
      const listText = availableModelCodes
        .map((code, idx) => `${idx + 1}. ${code}${code === selectedModel ? ` ✓ (current: ${displayedModel})` : ''}`)
        .join('\n');
      const reply = `Available Antigravity models:\n${listText}\n\nUse \`/model <number or name>\` (e.g. \`/model argon high\` or \`/model 1\`) or the model picker to switch.`;
      messageBuffer.addMessage(reply, 'status');
      session.sendSessionEvent({ type: 'message', message: reply });
      session.sendSessionEvent({ type: 'ready' });
      return;
    }

    const slashModelMatch = attachmentsForThisMessage.length === 0 ? /^\/model\s+(.+)$/i.exec(trimmedText) : null;
    if (slashModelMatch) {
      const rawArg = slashModelMatch[1].trim();
      const numericIndex = /^\d+$/.test(rawArg) ? Number(rawArg) - 1 : -1;
      if (numericIndex >= 0 && numericIndex < availableModelCodes.length) {
        syncDisplayedModel(availableModelCodes[numericIndex]);
      } else {
        const parts = rawArg.split(/\s+/);
        const maybeEffort = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
        if (['low', 'medium', 'high', 'xhigh'].includes(maybeEffort)) {
          syncDisplayedModel(parts.slice(0, -1).join(' '), maybeEffort);
        } else {
          syncDisplayedModel(rawArg);
        }
      }
      const confirmMsg = `Switched Antigravity model to: ${displayedModel}`;
      messageBuffer.addMessage(confirmMsg, 'status');
      session.sendSessionEvent({ type: 'message', message: confirmMsg });
      session.sendSessionEvent({ type: 'ready' });
      return;
    }

    const displayUserLine = attachmentsForThisMessage.length > 0
      ? `${userText ? `${userText} ` : ''}[${attachmentsForThisMessage.length} image(s)]`
      : userText;
    messageBuffer.addMessage(displayUserLine, 'user');
    messageQueue.push(userText, {}, attachmentsForThisMessage);
  }, (error) => {
    logger.warn('[agy] Failed to handle user message', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  });

  session.onUserMessage(handleUserMessage);
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

      const preparedImages = await prepareAgyImagePrompt({
        message: batch.message,
        attachments: batch.attachments,
        sessionId: session.sessionId,
      });
      if ((batch.attachments?.length ?? 0) > 0 && preparedImages.imagePaths.length === 0 && !batch.message.trim()) {
        session.sendSessionEvent({
          type: 'message',
          message: 'No supported images were available to send to Antigravity.',
        });
        session.sendSessionEvent({ type: 'ready' });
        continue;
      }

      log(`Incoming prompt: ${preparedImages.prompt.slice(0, 200)}`);
      errorReportedForCurrentTurn = false;
      // The first turn waits (at most agy models' timeout) so a default the
      // account lacks is swapped before it fails.
      await modelsReady;
      sendEnvelopes(sessionManager.startTurn());
      try {
        await backend.sendPrompt(process.cwd(), preparedImages.prompt, {
          addDirs: preparedImages.cacheDir ? [preparedImages.cacheDir] : undefined,
        });
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!errorReportedForCurrentTurn) {
          session.sendSessionEvent({ type: 'message', message: `Antigravity error: ${msg}` });
          errorReportedForCurrentTurn = true;
        }
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
    await cleanupAgyImageCacheDir({ sessionId: session.sessionId });
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
