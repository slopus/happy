/**
 * OpenCode CLI Entry Point
 * 
 * This module provides the main entry point for running the OpenCode agent
 * through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
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

import { createOpencodeBackend } from '@/agent/factories/opencode';
import type { AgentBackend, AgentMessage } from '@/agent';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import { OpencodePermissionHandler } from '@/opencode/utils/permissionHandler';
import type { OpencodeMode, OpencodeMessagePayload } from '@/opencode/types';
import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/opencode/constants';
import { isOpencodeAuthenticated, promptOpencodeAuth, isOpencodeInstalled, promptOpencodeInstall } from '@/opencode/utils/checkAuth';


/**
 * Main entry point for the opencode command with ink UI
 */
export async function runOpencode(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  model?: string;  // From --model flag
}): Promise<void> {
  //
  // Check OpenCode installation and authentication
  //

  if (!isOpencodeInstalled()) {
    promptOpencodeInstall();
    process.exit(1);
  }

  const isAuthenticated = await isOpencodeAuthenticated();
  if (!isAuthenticated) {
    promptOpencodeAuth();
    process.exit(1);
  }

  //
  // Define session
  //

  const sessionTag = randomUUID();

  // Set backend for offline warnings (before any API calls)
  connectionState.setBackend('OpenCode');

  const api = await ApiClient.create(opts.credentials);


  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/anomalyco/opencode/issues`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  //
  // Create session
  //

  const { state, metadata } = createSessionMetadata({
    flavor: 'opencode',
    machineId,
    startedBy: opts.startedBy
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable case - create offline stub with hot reconnection
  let session: ApiSessionClient;
  // Permission handler declared here so it can be updated in onSessionSwap callback
  let permissionHandler: OpencodePermissionHandler;

  // Session swap synchronization to prevent race conditions during message processing
  let isProcessingMessage = false;
  let pendingSessionSwap: ApiSessionClient | null = null;

  const applyPendingSessionSwap = () => {
    if (pendingSessionSwap) {
      logger.debug('[opencode] Applying pending session swap');
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
      if (isProcessingMessage) {
        logger.debug('[opencode] Session swap requested during message processing - queueing');
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

  // Report to daemon (only if we have a real session)
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
      } else {
        logger.debug(`[START] Reported session ${response.id} to daemon`);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }
  }

  const messageQueue = new MessageQueue2<OpencodeMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = opts.model; // Initialize with CLI --model flag

  session.onUserMessage((message) => {
    // Resolve permission mode (validate)
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        updatePermissionMode(messagePermissionMode);
        logger.debug(`[OpenCode] Permission mode updated from user message to: ${currentPermissionMode}`);
      } else {
        logger.debug(`[OpenCode] Invalid permission mode received: ${message.meta.permissionMode}`);
      }
    } else {
      logger.debug(`[OpenCode] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
    }
    
    // Initialize permission mode if not set yet
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
    }

    // Resolve model
    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      if (message.meta.model === null) {
        messageModel = undefined;
        currentModel = undefined;
      } else if (message.meta.model) {
        const previousModel = currentModel;
        messageModel = message.meta.model;
        currentModel = messageModel;
        if (previousModel !== messageModel) {
          updateDisplayedModel(messageModel);
          messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
          logger.debug(`[OpenCode] Model changed from ${previousModel} to ${messageModel}`);
        }
      }
    }

    // Build the full prompt with appendSystemPrompt if provided
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: OpencodeMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage,
    };
    messageQueue.push(fullPrompt, mode);
  });

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  // Track if this is the first message to include system prompt only once
  let isFirstMessage = true;

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'OpenCode is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[OpenCode] Failed to send ready push', pushError);
    }
  };

  const emitReadyIfIdle = (): boolean => {
    if (shouldExit) {
      return false;
    }
    if (thinking) {
      return false;
    }
    if (isResponseInProgress) {
      return false;
    }
    if (messageQueue.size() > 0) {
      return false;
    }

    sendReady();
    return true;
  };

  //
  // Abort handling
  //

  let abortController = new AbortController();
  let shouldExit = false;
  let opencodeBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;

  async function handleAbort() {
    logger.debug('[OpenCode] Abort requested - stopping current task');
    
    session.sendAgentMessage('opencode', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (opencodeBackend && acpSessionId) {
        await opencodeBackend.cancel(acpSessionId);
      }
      logger.debug('[OpenCode] Abort completed - session remains active');
    } catch (error) {
      logger.debug('[OpenCode] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[OpenCode] Kill session requested - terminating process');
    await handleAbort();
    logger.debug('[OpenCode] Abort completed, proceeding with termination');

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

      if (opencodeBackend) {
        await opencodeBackend.dispose();
      }

      logger.debug('[OpenCode] Session termination complete, exiting');
      process.exit(0);
    } catch (error) {
      logger.debug('[OpenCode] Error during session termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  //
  // Initialize Ink UI
  //

  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  // Track current model for UI display
  let displayedModel: string | undefined = opts.model || 'opencode-default';

  const updateDisplayedModel = (model: string | undefined) => {
    if (model === undefined) {
      return;
    }
    
    const oldModel = displayedModel;
    displayedModel = model;
    
    if (hasTTY && oldModel !== model) {
      logger.debug(`[opencode] Adding model update message to buffer: [MODEL:${model}]`);
      messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    }
  };

  // Update permission handler when permission mode changes
  const updatePermissionMode = (mode: PermissionMode) => {
    if (permissionHandler) {
      permissionHandler.setPermissionMode(mode);
    }
  };

  if (hasTTY) {
    console.clear();
    const DisplayComponent = () => {
      const currentModelValue = displayedModel || 'opencode-default';
      return React.createElement(OpencodeDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: currentModelValue,
        onExit: async () => {
          logger.debug('[opencode]: Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        }
      });
    };
    
    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false
    });
    
    // Send initial model to UI
    const initialModelName = displayedModel || 'opencode-default';
    logger.debug(`[opencode] Sending initial model to UI: ${initialModelName}`);
    messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  //
  // Start Happy MCP server and create OpenCode backend
  //

  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create permission handler
  permissionHandler = new OpencodePermissionHandler(session);

  // Accumulate response text for sending complete message to mobile
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let hadToolCallInTurn = false;
  let taskStartedSent = false;

  /**
   * Set up message handler for OpenCode backend
   */
  function setupOpencodeMessageHandler(backend: AgentBackend): void {
    backend.onMessage((msg: AgentMessage) => {

    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          if (!isResponseInProgress) {
            messageBuffer.removeLastMessage('system');
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            isResponseInProgress = true;
            logger.debug(`[opencode] Started new response, first chunk length: ${msg.textDelta.length}`);
          } else {
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            logger.debug(`[opencode] Updated response, chunk length: ${msg.textDelta.length}`);
          }
          accumulatedResponse += msg.textDelta;
        }
        break;

      case 'status':
        const statusDetail = msg.detail 
          ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
          : '';
        logger.debug(`[opencode] Status changed: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);
        
        if (msg.status === 'error') {
          logger.debug(`[opencode] Error status received: ${statusDetail || 'Unknown error'}`);
          
          session.sendAgentMessage('opencode', {
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }
        
        if (msg.status === 'running') {
          thinking = true;
          session.keepAlive(thinking, 'remote');
          
          if (!taskStartedSent) {
            session.sendAgentMessage('opencode', {
              type: 'task_started',
              id: randomUUID(),
            });
            taskStartedSent = true;
          }
          
          messageBuffer.addMessage('Thinking...', 'system');
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          // Don't change thinking state here - will be set in finally block
        } else if (msg.status === 'error') {
          thinking = false;
          session.keepAlive(thinking, 'remote');
          accumulatedResponse = '';
          isResponseInProgress = false;
          
          let errorMessage = 'Unknown error';
          if (msg.detail) {
            if (typeof msg.detail === 'object') {
              const detailObj = msg.detail as Record<string, unknown>;
              errorMessage = (detailObj.message as string) || 
                           (detailObj.details as string) || 
                           JSON.stringify(detailObj);
            } else {
              errorMessage = String(msg.detail);
            }
          }
          
          // Check for authentication error
          if (errorMessage.includes('Authentication') || errorMessage.includes('auth')) {
            errorMessage = `Authentication error. Run 'opencode auth login' to configure API keys.`;
          }
          
          messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          
          session.sendAgentMessage('opencode', {
            type: 'message',
            message: `Error: ${errorMessage}`,
          });
        }
        break;

      case 'tool-call':
        hadToolCallInTurn = true;
        
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        logger.debug(`[opencode] Tool call received: ${msg.toolName} (${msg.callId})`);
        
        messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendAgentMessage('opencode', {
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;

      case 'tool-result':
        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
        const resultText = typeof msg.result === 'string' 
          ? msg.result.substring(0, 200)
          : JSON.stringify(msg.result).substring(0, 200);
        const truncatedResult = resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');
        
        logger.debug(`[opencode] ${isError ? '✗' : '✓'} Tool result: ${msg.toolName} (${msg.callId})`);
        
        if (isError) {
          const errorMsg = (msg.result as any).error || 'Tool call failed';
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
        } else {
          messageBuffer.addMessage(`Result: ${truncatedResult}`, 'result');
        }
        
        session.sendAgentMessage('opencode', {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: randomUUID(),
        });
        break;

      case 'fs-edit':
        messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        
        session.sendAgentMessage('opencode', {
          type: 'file-edit',
          description: msg.description,
          diff: msg.diff,
          filePath: msg.path || 'unknown',
          id: randomUUID(),
        });
        break;

      case 'terminal-output':
        messageBuffer.addMessage(msg.data, 'result');
        session.sendAgentMessage('opencode', {
          type: 'terminal-output',
          data: msg.data,
          callId: (msg as any).callId || randomUUID(),
        });
        break;

      case 'permission-request':
        const payload = (msg as any).payload || {};
        session.sendAgentMessage('opencode', {
          type: 'permission-request',
          permissionId: msg.id,
          toolName: payload.toolName || (msg as any).reason || 'unknown',
          description: (msg as any).reason || payload.toolName || '',
          options: payload,
        });
        break;

      case 'event':
        // Handle thinking events
        if (msg.name === 'thinking') {
          const thinkingPayload = msg.payload as { text?: string } | undefined;
          const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
            ? String(thinkingPayload.text || '')
            : '';
          if (thinkingText) {
            logger.debug(`[opencode] Thinking chunk: ${thinkingText.substring(0, 100)}...`);
            
            if (!thinkingText.startsWith('**')) {
              const thinkingPreview = thinkingText.substring(0, 100);
              messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
          }
          session.sendAgentMessage('opencode', {
            type: 'thinking',
            text: thinkingText,
          });
        }
        break;
    }
    });
  }

  let first = true;

  try {
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: OpencodeMode; isolate: boolean; hash: string } | null = null;

    while (!shouldExit) {
      let message: { message: string; mode: OpencodeMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[opencode] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            logger.debug('[opencode] Main loop: wait aborted, continuing...');
            continue;
          }
          logger.debug('[opencode] Main loop: no batch received, breaking...');
          break;
        }
        logger.debug(`[opencode] Main loop: received message from queue (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) {
        break;
      }

      // Handle mode change - restart session if permission mode or model changed
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[OpenCode] Mode changed – restarting OpenCode session');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        messageBuffer.addMessage('Starting new OpenCode session (mode changed)...', 'status');
        
        permissionHandler.reset();
        
        if (opencodeBackend) {
          await opencodeBackend.dispose();
          opencodeBackend = null;
        }

        // Create new backend with new model
        const modelToUse = message.mode?.model;
        const backendResult = createOpencodeBackend({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          model: modelToUse,
        });
        opencodeBackend = backendResult.backend;

        setupOpencodeMessageHandler(opencodeBackend);

        const actualModel = backendResult.model;
        logger.debug(`[opencode] Model change - modelToUse=${modelToUse}, actualModel=${actualModel}`);
        
        logger.debug('[opencode] Starting new ACP session with model:', actualModel);
        const { sessionId } = await opencodeBackend.startSession();
        acpSessionId = sessionId;
        logger.debug(`[opencode] New ACP session started: ${acpSessionId}`);
        
        updateDisplayedModel(actualModel);
        updatePermissionMode(message.mode.permissionMode);
        
        wasSessionCreated = true;
        currentModeHash = message.hash;
        first = false;
      }

      currentModeHash = message.hash;
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      isProcessingMessage = true;

      try {
        if (first || !wasSessionCreated) {
          if (!opencodeBackend) {
            const modelToUse = message.mode?.model;
            const backendResult = createOpencodeBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              model: modelToUse,
            });
            opencodeBackend = backendResult.backend;

            setupOpencodeMessageHandler(opencodeBackend);

            const actualModel = backendResult.model;
            logger.debug(`[opencode] Backend created, model will be: ${actualModel} (from ${backendResult.modelSource})`);
            updateDisplayedModel(actualModel);
          }
          
          if (!acpSessionId) {
            logger.debug('[opencode] Starting ACP session...');
            updatePermissionMode(message.mode.permissionMode);
            const { sessionId } = await opencodeBackend.startSession();
            acpSessionId = sessionId;
            logger.debug(`[opencode] ACP session started: ${acpSessionId}`);
            wasSessionCreated = true;
            currentModeHash = message.hash;
          }
        }
        
        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }
         
        // Reset for new prompt
        accumulatedResponse = '';
        isResponseInProgress = false;
        hadToolCallInTurn = false;
        taskStartedSent = false;
        
        if (!opencodeBackend || !acpSessionId) {
          throw new Error('OpenCode backend or session not initialized');
        }
        
        let promptToSend = message.message;
        
        logger.debug(`[opencode] Sending prompt to OpenCode (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);
        
        await opencodeBackend.sendPrompt(acpSessionId, promptToSend);
        logger.debug('[opencode] Prompt sent successfully');
        
        if (opencodeBackend.waitForResponseComplete) {
          await opencodeBackend.waitForResponseComplete(120000);
          logger.debug('[opencode] Response complete');
        }
        
        if (first) {
          first = false;
        }
      } catch (error) {
        logger.debug('[opencode] Error in opencode session:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          let errorMsg = 'Process error occurred';
          
          if (typeof error === 'object' && error !== null) {
            const errObj = error as any;
            const errorDetails = errObj.data?.details || errObj.details || '';
            const errorMessage = errObj.message || errObj.error?.message || '';
            
            if (Object.keys(error).length === 0) {
              errorMsg = 'Failed to start OpenCode. Is "opencode" CLI installed? Run: npm install -g opencode';
            } else if (errObj.message || errorMessage) {
              errorMsg = errorDetails || errorMessage || errObj.message;
            }
          } else if (error instanceof Error) {
            errorMsg = error.message;
          }
          
          messageBuffer.addMessage(errorMsg, 'status');
          session.sendAgentMessage('opencode', {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        permissionHandler.reset();
        
        if (accumulatedResponse.trim()) {
          const messagePayload: OpencodeMessagePayload = {
            type: 'message',
            message: accumulatedResponse,
            id: randomUUID(),
          };
          
          logger.debug(`[opencode] Sending complete message to mobile (length: ${accumulatedResponse.length})`);
          session.sendAgentMessage('opencode', messagePayload);
          accumulatedResponse = '';
          isResponseInProgress = false;
        }
        
        session.sendAgentMessage('opencode', {
          type: 'task_complete',
          id: randomUUID(),
        });
        
        hadToolCallInTurn = false;
        taskStartedSent = false;
        
        thinking = false;
        session.keepAlive(thinking, 'remote');
        
        emitReadyIfIdle();

        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[opencode] Main loop: turn completed, continuing (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    logger.debug('[opencode]: Final cleanup start');

    if (reconnectionHandle) {
      logger.debug('[opencode]: Cancelling offline reconnection');
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[opencode]: Error while closing session', e);
    }

    if (opencodeBackend) {
      await opencodeBackend.dispose();
    }

    happyServer.stop();

    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    if (hasTTY) {
      try { process.stdin.pause(); } catch { /* ignore */ }
    }

    clearInterval(keepAliveInterval);
    if (inkInstance) {
      inkInstance.unmount();
    }
    messageBuffer.clear();

    logger.debug('[opencode]: Final cleanup completed');
  }
}
