/**
 * Kimi CLI Entry Point
 *
 * This module provides the main entry point for running the Kimi agent
 * through Happy CLI via ACP protocol.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend } from '@/agent';

import { createKimiBackend, type KimiBackendResult } from '@/agent/factories/kimi';
import { KimiDisplay } from '@/ui/ink/KimiDisplay';
import { KimiPermissionHandler } from '@/kimi/utils/permissionHandler';
import { KimiReasoningProcessor } from '@/kimi/utils/reasoningProcessor';
import { KimiDiffProcessor } from '@/kimi/utils/diffProcessor';
import type { KimiMode } from '@/kimi/types';
import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/kimi/constants';
import { displayQRCode } from '@/ui/qrcode';

/**
 * Provider name used when sending messages to the Happy Server.
 * Using 'gemini' for backward compatibility with older App versions that don't have 'kimi'
 * in their provider whitelist. The session metadata (flavor: 'kimi') already identifies
 * this as a Kimi session. Once all App versions support 'kimi' provider, this can be changed.
 */
const SERVER_PROVIDER: 'gemini' = 'gemini';

/**
 * Wait for any key press from stdin
 */
function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    const onData = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      process.stdin.off('data', onData);
      try {
        process.stdin.setRawMode(false);
      } catch { /* ignore */ }
    };

    // Setup raw mode to capture single keypress
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.once('data', onData);
    } catch (error) {
      // If we can't setup raw mode, just resolve after a timeout
      setTimeout(resolve, 5000);
    }
  });
}

/**
 * Main entry point for the kimi command with ink UI
 */
export async function runKimi(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  const sessionTag = randomUUID();

  // Set backend for offline warnings
  connectionState.setBackend('Kimi');

  const api = await ApiClient.create(opts.credentials);

  // Machine setup
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings. Please report this issue.`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  // Create session
  const { state, metadata } = createSessionMetadata({
    flavor: 'kimi',
    machineId,
    startedBy: opts.startedBy
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable case
  let session: ApiSessionClient;
  // Permission handler declared here so it can be updated in onSessionSwap callback
  // (assigned later after Happy server setup)
  let permissionHandler: KimiPermissionHandler;

  // Session swap synchronization to prevent race conditions during message processing
  // When a swap is requested during processing, it's queued and applied after the current cycle
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  /**
   * Apply a pending session swap. Called between message processing cycles.
   * This ensures session swaps happen at safe points, not during message processing.
   */
  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[Kimi] Applying pending session swap');
      session = pendingSessionSwap;
      if (permissionHandler) {
        permissionHandler.updateSession(pendingSessionSwap);
      }
      pendingSessionSwap = null;
    }
  };

  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      // If we're processing a message, queue the swap for later
      if (isProcessingMessage) {
        logger.debug('[Kimi] Session swap requested during message processing - queueing');
        pendingSessionSwap = newSession;
      } else {
        session = newSession;
        if (permissionHandler) {
          permissionHandler.updateSession(newSession);
        }
      }
    }
  });
  session = initialSession;

  // Report to daemon
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon:`, result.error);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon:', error);
    }
  }

  const messageQueue = new MessageQueue2<KimiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;
  let isFirstMessage = true;

  // Accumulate response for sending to mobile app
  let accumulatedResponse = '';
  let isResponseInProgress = false;

  /**
   * Update permission mode on the handler
   */
  const updatePermissionMode = (mode: PermissionMode) => {
    if (permissionHandler) {
      permissionHandler.setPermissionMode(mode);
    }
  };

  session.onUserMessage((message) => {
    // Resolve permission mode (validate)
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        updatePermissionMode(messagePermissionMode);
        logger.debug(`[Kimi] Permission mode updated from user message to: ${currentPermissionMode}`);
      } else {
        logger.debug(`[Kimi] Invalid permission mode received: ${message.meta.permissionMode}`);
      }
    }

    // Initialize permission mode if not set yet
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
    }

    // Resolve model
    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      messageModel = message.meta.model || undefined;
      currentModel = messageModel;
      logger.debug(`[Kimi] Model updated: ${messageModel || 'default'}`);
    }

    // Build the full prompt with appendSystemPrompt if provided
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: KimiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
    };
    messageQueue.push(fullPrompt, mode);
  });

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Kimi is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Kimi] Failed to send ready push', pushError);
    }
  };

  // Display connection info for mobile app
  function displayConnectionInfo(): void {
    const sessionUrl = `${configuration.webappUrl}/s/${session.sessionId}`;
    const appUrl = `happy://session?id=${session.sessionId}`;

    console.log('\n' + '='.repeat(60));
    console.log('Kimi session started!');
    console.log('='.repeat(60));
    console.log('\nConnect from your mobile device:');
    console.log('\n1. Scan QR code with Happy App:');

    // Display QR code
    try {
      displayQRCode(appUrl);
    } catch (e) {
      // If QR code fails, just show the URL
      console.log('   (QR code unavailable)');
    }

    console.log('\n2. Or open this URL in your browser:');
    console.log(`   ${sessionUrl}`);
    console.log('\n3. Or manually enter session ID in the app:');
    console.log(`   Session ID: ${session.sessionId}`);
    console.log('='.repeat(60) + '\n');

    // Also log to debug
    logger.debug('[Kimi] Session URL:', sessionUrl);
    logger.debug('[Kimi] App URL:', appUrl);
  }

  // Abort handling
  let abortController = new AbortController();
  let shouldExit = false;
  let kimiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;

  async function handleAbort() {
    logger.debug('[Kimi] Abort requested');

    session.sendAgentMessage(SERVER_PROVIDER, {
      type: 'turn_aborted',
      id: randomUUID(),
    });

    try {
      abortController.abort();
      messageQueue.reset();
      reasoningProcessor.abort();
      diffProcessor.reset();
      accumulatedResponse = '';
      isResponseInProgress = false;
      if (kimiBackend && acpSessionId) {
        await kimiBackend.cancel(acpSessionId);
      }
    } catch (error) {
      logger.debug('[Kimi] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Kimi] Kill session requested');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated'
        }));

        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();
      happyServer.stop();

      if (kimiBackend) {
        await kimiBackend.dispose();
      }

      process.exit(0);
    } catch (error) {
      logger.debug('[Kimi] Error during termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Initialize UI
  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  // Display connection info before UI clears the screen
  displayConnectionInfo();

  // Wait for user to press any key before entering UI
  if (hasTTY) {
    console.log('\nPress any key to continue...');
    await waitForKeypress();
    console.clear();
    inkInstance = render(React.createElement(KimiDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.logFilePath : undefined,
      onExit: async () => {
        logger.debug('[Kimi]: Exiting via Ctrl-C');
        shouldExit = true;
        await handleAbort();
      }
    }), {
      exitOnCtrlC: false,
      patchConsole: false
    });
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  // Start Happy MCP server and create Kimi backend
  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create permission handler
  permissionHandler = new KimiPermissionHandler(session);

  // Create reasoning processor for forwarding thinking output to mobile app
  const reasoningProcessor = new KimiReasoningProcessor();

  // Create diff processor for tracking file edits
  const diffProcessor = new KimiDiffProcessor();

  const kimiBackendResult: KimiBackendResult = createKimiBackend({
    cwd: metadata.path,
    mcpServers,
    permissionHandler: {
      handleToolCall: (toolCallId: string, toolName: string, input: unknown) =>
        permissionHandler.handleToolCall(toolCallId, toolName, input),
    },
  });
  kimiBackend = kimiBackendResult.backend;

  // Wire reasoning processor to send messages to server
  const sendProcessorMessage = (processorMsg: any) => {
    session.sendAgentMessage(SERVER_PROVIDER, processorMsg);
  };
  reasoningProcessor.setMessageCallback(sendProcessorMessage);
  diffProcessor.setMessageCallback(sendProcessorMessage);

  // Register message handler
  kimiBackend.onMessage((msg) => {
    switch (msg.type) {
      case 'status':
        if (msg.status === 'starting') {
          thinking = true;
          session.keepAlive(thinking, 'remote');
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          thinking = false;
          session.keepAlive(thinking, 'remote');

          // Complete any pending reasoning
          reasoningProcessor.complete();

          // Send accumulated response to mobile app when response is complete
          if (accumulatedResponse && isResponseInProgress) {
            session.sendAgentMessage(SERVER_PROVIDER, {
              type: 'message',
              message: accumulatedResponse,
            });
            logger.debug(`[Kimi] Sent complete response to mobile app, length: ${accumulatedResponse.length}`);
            accumulatedResponse = '';
            isResponseInProgress = false;
          }

          // Emit ready when idle and queue empty
          if (!shouldExit && messageQueue.size() === 0) {
            sendReady();
          }
        } else if (msg.status === 'error') {
          logger.debug('[Kimi] Error:', msg.detail);
          messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');

          // Send error to mobile app
          session.sendAgentMessage(SERVER_PROVIDER, {
            type: 'message',
            message: `Error: ${msg.detail}`,
          });
        }
        break;

      case 'model-output':
        thinking = true;
        session.keepAlive(thinking, 'remote');
        if (msg.textDelta) {
          // Accumulate response instead of sending each chunk
          accumulatedResponse += msg.textDelta;
          if (!isResponseInProgress) {
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            isResponseInProgress = true;
            logger.debug(`[Kimi] Started new response, first chunk length: ${msg.textDelta.length}`);
          } else {
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            logger.debug(`[Kimi] Updated response, chunk length: ${msg.textDelta.length}, total accumulated: ${accumulatedResponse.length}`);
          }
        }
        break;

      case 'event':
        // Handle thinking/reasoning events from ACP
        if (msg.name === 'thinking' && msg.payload && typeof msg.payload === 'object') {
          const text = (msg.payload as { text?: string }).text;
          if (text) {
            thinking = true;
            session.keepAlive(thinking, 'remote');
            reasoningProcessor.processChunk(text);
          }
        }
        break;

      case 'tool-call':
        thinking = true;
        session.keepAlive(thinking, 'remote');
        session.sendAgentMessage(SERVER_PROVIDER, {
          type: 'tool-call',
          callId: msg.callId,
          name: msg.toolName,
          input: msg.args,
          id: msg.callId,
        });
        break;

      case 'tool-result':
        session.sendAgentMessage(SERVER_PROVIDER, {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: msg.callId,
        });

        // Check for diff information in tool results
        if (msg.result && typeof msg.result === 'object') {
          diffProcessor.processToolResult(msg.toolName || '', msg.result, msg.callId);
        }
        break;

      case 'fs-edit':
        // Track file edits via diff processor
        if (msg.path) {
          diffProcessor.processFsEdit(msg.path, msg.description, msg.diff);
        }
        break;

      case 'permission-request':
        // Permission handling is now done via the KimiPermissionHandler passed to createKimiBackend
        logger.debug('[Kimi] Permission request received:', msg);
        break;
    }
  });

  // Main loop
  try {
    while (!shouldExit) {
      // Apply any pending session swap between message cycles
      applyPendingSessionSwap();

      const nextMessage = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
      if (!nextMessage) {
        continue;
      }

      const { message, mode } = nextMessage;

      isProcessingMessage = true;

      // Start session if not started
      if (!acpSessionId) {
        const sessionResult = await kimiBackend.startSession();
        acpSessionId = sessionResult.sessionId;
        logger.debug(`[Kimi] Started ACP session: ${acpSessionId}`);
      }

      // Send prompt
      thinking = true;
      session.keepAlive(thinking, 'remote');

      try {
        await kimiBackend.sendPrompt(acpSessionId, message);
        await kimiBackend.waitForResponseComplete?.(120000);
      } catch (error) {
        logger.debug('[Kimi] Error during prompt:', error);
        messageBuffer.addMessage('Error processing request', 'status');
      }

      // Fallback: send any accumulated response that wasn't sent by idle handler
      if (accumulatedResponse && isResponseInProgress) {
        session.sendAgentMessage(SERVER_PROVIDER, {
          type: 'message',
          message: accumulatedResponse,
        });
        logger.debug(`[Kimi] Sent response via fallback (idle handler missed), length: ${accumulatedResponse.length}`);
        accumulatedResponse = '';
        isResponseInProgress = false;
      }

      thinking = false;
      session.keepAlive(thinking, 'remote');
      isProcessingMessage = false;

      // Apply any session swap that was queued during processing
      applyPendingSessionSwap();

      // Send ready if queue empty
      if (messageQueue.size() === 0) {
        sendReady();
      }
    }
  } catch (error) {
    logger.debug('[Kimi] Main loop error:', error);
    isProcessingMessage = false;
  } finally {
    // Cleanup
    clearInterval(keepAliveInterval);

    if (inkInstance) {
      inkInstance.unmount();
    }

    if (kimiBackend) {
      await kimiBackend.dispose();
    }

    happyServer.stop();
    stopCaffeinate();

    if (session) {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    }
  }
}
