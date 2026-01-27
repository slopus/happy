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

import { createOpenCodeBackend } from '@/agent/factories/opencode';
import type { AgentBackend, AgentMessage } from '@/agent';
import { OpenCodeDisplay } from '@/ui/ink/OpenCodeDisplay';
import { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { PermissionMode } from '@/api/types';
import { 
  OPENCODE_MODEL_ENV, 
  DEFAULT_OPENCODE_MODEL, 
  CHANGE_TITLE_INSTRUCTION 
} from '@/opencode/constants';

/**
 * Mode configuration for OpenCode
 */
interface OpenCodeMode {
  permissionMode: PermissionMode;
  model?: string;
  originalUserMessage?: string;
}

/**
 * Main entry point for the opencode command with ink UI
 */
export async function runOpenCode(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  const sessionTag = randomUUID();

  // Set backend for offline warnings
  connectionState.setBackend('OpenCode');

  const api = await ApiClient.create(opts.credentials);

  // Machine setup
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings. Please run "happy auth login" first.`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  // Create session
  const { state, metadata } = createSessionMetadata({
    flavor: 'opencode',
    machineId,
    startedBy: opts.startedBy
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Session setup with offline reconnection
  let session: ApiSessionClient;
  let permissionHandler: GeminiPermissionHandler;

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

  const messageQueue = new MessageQueue2<OpenCodeMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;

  session.onUserMessage((message) => {
    // Resolve permission mode
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        updatePermissionMode(messagePermissionMode);
        logger.debug(`[OpenCode] Permission mode updated to: ${currentPermissionMode}`);
      }
    }
    
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
          logger.debug(`[OpenCode] Model changed to ${messageModel}`);
        }
      }
    }

    // Build prompt with system instructions
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: OpenCodeMode = {
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
    if (shouldExit) return false;
    if (thinking) return false;
    if (isResponseInProgress) return false;
    if (messageQueue.size() > 0) return false;
    sendReady();
    return true;
  };

  // Abort handling
  let abortController = new AbortController();
  let shouldExit = false;
  let openCodeBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;

  async function handleAbort() {
    logger.debug('[OpenCode] Abort requested');
    
    session.sendAgentMessage('opencode', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    reasoningProcessor.abort();
    diffProcessor.reset();
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (openCodeBackend && acpSessionId) {
        await openCodeBackend.cancel(acpSessionId);
      }
      logger.debug('[OpenCode] Abort completed');
    } catch (error) {
      logger.debug('[OpenCode] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[OpenCode] Kill session requested');
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

      if (openCodeBackend) {
        await openCodeBackend.dispose();
      }

      logger.debug('[OpenCode] Session termination complete');
      process.exit(0);
    } catch (error) {
      logger.debug('[OpenCode] Error during termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Initialize UI
  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  let displayedModel: string | undefined = process.env[OPENCODE_MODEL_ENV] || DEFAULT_OPENCODE_MODEL;

  const updateDisplayedModel = (model: string | undefined) => {
    if (model === undefined) return;
    const oldModel = displayedModel;
    displayedModel = model;
    if (hasTTY && oldModel !== model) {
      messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    }
  };

  if (hasTTY) {
    console.clear();
    const DisplayComponent = () => {
      const currentModelValue = displayedModel || DEFAULT_OPENCODE_MODEL;
      return React.createElement(OpenCodeDisplay, {
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
    
    const initialModelName = displayedModel || DEFAULT_OPENCODE_MODEL;
    messageBuffer.addMessage(`[MODEL:${initialModelName}]`, 'system');
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  // Start Happy MCP server
  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create permission handler
  permissionHandler = new GeminiPermissionHandler(session);
  
  // Create processors
  const reasoningProcessor = new GeminiReasoningProcessor((message) => {
    session.sendAgentMessage('opencode', message);
  });
  
  const diffProcessor = new GeminiDiffProcessor((message) => {
    session.sendAgentMessage('opencode', message);
  });
  
  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };

  // State tracking
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let hadToolCallInTurn = false;
  let taskStartedSent = false;

  /**
   * Set up message handler for OpenCode backend
   */
  function setupOpenCodeMessageHandler(backend: AgentBackend): void {
    backend.onMessage((msg: AgentMessage) => {
      switch (msg.type) {
        case 'model-output':
          if (msg.textDelta) {
            if (!isResponseInProgress) {
              messageBuffer.removeLastMessage('system');
              messageBuffer.addMessage(msg.textDelta, 'assistant');
              isResponseInProgress = true;
            } else {
              messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            }
            accumulatedResponse += msg.textDelta;
          }
          break;

        case 'status':
          const statusDetail = msg.detail 
            ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
            : '';
          logger.debug(`[opencode] Status: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);
          
          if (msg.status === 'error') {
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
            reasoningProcessor.complete();
          } else if (msg.status === 'error') {
            thinking = false;
            session.keepAlive(thinking, 'remote');
            accumulatedResponse = '';
            isResponseInProgress = false;
            
            let errorMessage = 'Unknown error';
            if (msg.detail) {
              if (typeof msg.detail === 'object') {
                const detailObj = msg.detail as Record<string, unknown>;
                errorMessage = (detailObj.message as string) || JSON.stringify(detailObj);
              } else {
                errorMessage = String(msg.detail);
              }
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
          logger.debug(`[opencode] Tool call: ${msg.toolName} (${msg.callId})`);
          messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}...` : ''}`, 'tool');
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
          
          logger.debug(`[opencode] Tool result: ${msg.toolName} (${msg.callId})`);
          
          if (!isError) {
            diffProcessor.processToolResult(msg.toolName, msg.result, msg.callId);
          }
          
          if (isError) {
            const errorMsg = (msg.result as any).error || 'Tool call failed';
            messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
          } else {
            messageBuffer.addMessage(`Result: ${resultText}...`, 'result');
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
          diffProcessor.processFsEdit(msg.path || '', msg.description, msg.diff);
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
          if (msg.name === 'thinking') {
            const thinkingPayload = msg.payload as { text?: string } | undefined;
            const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
              ? String(thinkingPayload.text || '')
              : '';
            if (thinkingText) {
              reasoningProcessor.processChunk(thinkingText);
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
    let pending: { message: string; mode: OpenCodeMode; isolate: boolean; hash: string } | null = null;

    while (!shouldExit) {
      let message: { message: string; mode: OpenCodeMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[opencode] Waiting for messages...');
        const waitSignal = abortController.signal;
        const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            continue;
          }
          break;
        }
        logger.debug(`[opencode] Received message (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) break;

      // Handle mode change - restart session
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[OpenCode] Mode changed - restarting session');
        messageBuffer.addMessage('Starting new session (mode changed)...', 'status');
        
        permissionHandler.reset();
        reasoningProcessor.abort();
        
        if (openCodeBackend) {
          await openCodeBackend.dispose();
          openCodeBackend = null;
        }

        const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
        const backendResult = createOpenCodeBackend({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          model: modelToUse,
        });
        openCodeBackend = backendResult.backend;
        setupOpenCodeMessageHandler(openCodeBackend);

        const actualModel = backendResult.model;
        logger.debug(`[opencode] Model: ${actualModel} (from ${backendResult.modelSource})`);
        
        const { sessionId } = await openCodeBackend.startSession();
        acpSessionId = sessionId;
        logger.debug(`[opencode] New ACP session: ${acpSessionId}`);
        
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
          if (!openCodeBackend) {
            const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
            const backendResult = createOpenCodeBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              model: modelToUse,
            });
            openCodeBackend = backendResult.backend;
            setupOpenCodeMessageHandler(openCodeBackend);

            const actualModel = backendResult.model;
            logger.debug(`[opencode] Backend created, model: ${actualModel}`);
            updateDisplayedModel(actualModel);
          }
          
          if (!acpSessionId) {
            logger.debug('[opencode] Starting ACP session...');
            updatePermissionMode(message.mode.permissionMode);
            const { sessionId } = await openCodeBackend.startSession();
            acpSessionId = sessionId;
            logger.debug(`[opencode] ACP session started: ${acpSessionId}`);
            wasSessionCreated = true;
            currentModeHash = message.hash;
          }
        }
        
        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }
         
        accumulatedResponse = '';
        isResponseInProgress = false;
        hadToolCallInTurn = false;
        taskStartedSent = false;
        
        if (!openCodeBackend || !acpSessionId) {
          throw new Error('OpenCode backend or session not initialized');
        }
        
        const promptToSend = message.message;
        logger.debug(`[opencode] Sending prompt (length: ${promptToSend.length})`);
        
        await openCodeBackend.sendPrompt(acpSessionId, promptToSend);
        logger.debug('[opencode] Prompt sent');
        
        if (openCodeBackend.waitForResponseComplete) {
          await openCodeBackend.waitForResponseComplete(120000);
          logger.debug('[opencode] Response complete');
        }
        
        if (first) {
          first = false;
        }
      } catch (error) {
        logger.debug('[opencode] Error:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          let errorMsg = 'Process error occurred';
          if (typeof error === 'object' && error !== null) {
            const errObj = error as any;
            errorMsg = errObj.message || errObj.details || String(error);
          }
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
          session.sendAgentMessage('opencode', { type: 'message', message: `Error: ${errorMsg}` });
        }
      } finally {
        thinking = false;
        session.keepAlive(thinking, 'remote');
        
        if (accumulatedResponse.trim()) {
          session.sendAgentMessage('opencode', {
            type: 'message',
            message: accumulatedResponse,
          });
        }
        
        session.sendAgentMessage('opencode', {
          type: 'task_complete',
          id: randomUUID(),
        });

        isProcessingMessage = false;
        applyPendingSessionSwap();
        
        emitReadyIfIdle();
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    
    if (reconnectionHandle) {
      reconnectionHandle.cancel();
    }
    
    if (openCodeBackend) {
      await openCodeBackend.dispose();
    }
    
    happyServer.stop();
    stopCaffeinate();
    
    if (inkInstance) {
      inkInstance.unmount();
    }
  }
}
