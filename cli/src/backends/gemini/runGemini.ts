/**
 * Gemini CLI Entry Point
 * 
 * This module provides the main entry point for running the Gemini agent
 * through Happy CLI. It manages the agent lifecycle, session state, and
 * communication with the Happy server and mobile app.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join, resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/mcp/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { registerKillSessionHandler } from '@/rpc/handlers/killSession';
import { stopCaffeinate } from '@/integrations/caffeinate';
import { connectionState } from '@/api/offline/serverConnectionErrors';
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection';
import { waitForMessagesOrPending } from '@/agent/runtime/waitForMessagesOrPending';
import type { ApiSessionClient } from '@/api/apiSession';
import { formatGeminiErrorForUi } from '@/backends/gemini/utils/formatGeminiErrorForUi';
import { buildTerminalMetadataFromRuntimeFlags } from '@/terminal/terminalMetadata';
import { maybeUpdatePermissionModeMetadata } from '@/agent/runtime/permissionModeMetadata';
import { applyStartupMetadataUpdateToSession, buildPermissionModeOverride } from '@/agent/runtime/startupMetadataUpdate';
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach';
import { persistTerminalAttachmentInfoIfNeeded, primeAgentStateForUi, reportSessionToDaemonIfRunning, sendTerminalFallbackMessageIfNeeded } from '@/agent/runtime/startupSideEffects';

import { createCatalogAcpBackend } from '@/agent/acp';
import type { GeminiBackendOptions, GeminiBackendResult } from '@/backends/gemini/acp/backend';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import { normalizeAvailableCommands, publishSlashCommandsToMetadata } from '@/agent/acp/commands/publishSlashCommands';
import type { AgentBackend, AgentMessage } from '@/agent';
import { GeminiTerminalDisplay } from '@/backends/gemini/ui/GeminiTerminalDisplay';
import { GeminiPermissionHandler } from '@/backends/gemini/utils/permissionHandler';
import { GeminiReasoningProcessor } from '@/backends/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/backends/gemini/utils/diffProcessor';
import type { GeminiMode, CodexMessagePayload } from '@/backends/gemini/types';
import { CODEX_GEMINI_PERMISSION_MODES, isCodexGeminiPermissionMode, type CodexGeminiPermissionMode, type PermissionMode } from '@/api/types';
import { GEMINI_MODEL_ENV, DEFAULT_GEMINI_MODEL } from '@/backends/gemini/constants';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import {
  readGeminiLocalConfig,
  saveGeminiModelToConfig,
  getInitialGeminiModel
} from '@/backends/gemini/utils/config';
import { maybeUpdateGeminiSessionIdMetadata } from '@/backends/gemini/utils/geminiSessionIdMetadata';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/backends/gemini/utils/optionsParser';
import { ConversationHistory } from '@/backends/gemini/utils/conversationHistory';
import {
  handleAcpModelOutputDelta,
  handleAcpStatusRunning,
  forwardAcpPermissionRequest,
  forwardAcpTerminalOutput,
} from '@/agent/acp/bridge/acpCommonHandlers';


/**
 * Main entry point for the gemini command with ink UI
 */
export async function runGemini(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  terminalRuntime?: import('@/terminal/terminalRuntimeFlags').TerminalRuntimeFlags | null;
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  existingSessionId?: string;
  resume?: string;
}): Promise<void> {
  //
  // Define session
  //

  
  const sessionTag = randomUUID();

  // Set backend for offline warnings (before any API calls)
  connectionState.setBackend('Gemini');

  const api = await ApiClient.create(opts.credentials);


  //
  // Machine
  //

  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  //
  // Fetch Gemini cloud token (from 'happy connect gemini')
  //
  let cloudToken: string | undefined = undefined;
  let currentUserEmail: string | undefined = undefined;
  try {
    const vendorToken = await api.getVendorToken('gemini');
    if (vendorToken?.oauth?.access_token) {
      cloudToken = vendorToken.oauth.access_token;
      logger.debug('[Gemini] Using OAuth token from Happy cloud');
      
      // Extract email from id_token for per-account project matching
      if (vendorToken.oauth.id_token) {
        try {
          const parts = vendorToken.oauth.id_token.split('.');
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (payload.email) {
              currentUserEmail = payload.email;
              logger.debug(`[Gemini] Current user email: ${currentUserEmail}`);
            }
          }
        } catch {
          logger.debug('[Gemini] Failed to decode id_token for email');
        }
      }
    }
  } catch (error) {
    logger.debug('[Gemini] Failed to fetch cloud token:', error);
  }

  //
  // Create session
  //

  const initialPermissionMode: PermissionMode =
    opts.permissionMode && isCodexGeminiPermissionMode(opts.permissionMode)
      ? opts.permissionMode
      : 'default';

  const { state, metadata } = createSessionMetadata({
    flavor: 'gemini',
    machineId,
    startedBy: opts.startedBy,
    terminalRuntime: opts.terminalRuntime ?? null,
    permissionMode: initialPermissionMode,
    permissionModeUpdatedAt: typeof opts.permissionModeUpdatedAt === 'number' ? opts.permissionModeUpdatedAt : Date.now(),
  });
  const terminal = buildTerminalMetadataFromRuntimeFlags(opts.terminalRuntime ?? null);

  // Handle server unreachable case - create offline stub with hot reconnection
  let session: ApiSessionClient;
  let reconnectionHandle: { cancel: () => void } | null = null;
  // Permission handler declared here so it can be updated in onSessionSwap callback
  // (assigned later after Happy server setup)
  let permissionHandler: GeminiPermissionHandler;

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
      logger.debug('[gemini] Applying pending session swap');
      session = pendingSessionSwap;
      if (permissionHandler) {
        permissionHandler.updateSession(pendingSessionSwap);
      }
      pendingSessionSwap = null;
    }
  };

  const normalizedExistingSessionId = typeof opts.existingSessionId === 'string' ? opts.existingSessionId.trim() : '';
  const permissionModeOverride = buildPermissionModeOverride({
    permissionMode: opts.permissionMode,
    permissionModeUpdatedAt: opts.permissionModeUpdatedAt,
  });

  let reportedSessionId: string | null = null;

  if (normalizedExistingSessionId) {
    logger.debug(`[gemini] Attaching to existing Happy session: ${normalizedExistingSessionId}`);
    const baseSession = await createBaseSessionForAttach({
      existingSessionId: normalizedExistingSessionId,
      metadata,
      state,
    });

    session = api.sessionSyncClient(baseSession);
    reportedSessionId = normalizedExistingSessionId;

    applyStartupMetadataUpdateToSession({
      session,
      next: metadata,
      nowMs: Date.now(),
      permissionModeOverride,
    });
  } else {
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    const offline = setupOfflineReconnection({
      api,
      sessionTag,
      metadata,
      state,
      response,
      onSessionSwap: (newSession) => {
        // If we're processing a message, queue the swap for later
        // This prevents race conditions where session changes mid-processing
        if (isProcessingMessage) {
          logger.debug('[gemini] Session swap requested during message processing - queueing');
          pendingSessionSwap = newSession;
        } else {
          // Safe to swap immediately
          session = newSession;
          if (permissionHandler) {
            permissionHandler.updateSession(newSession);
          }
        }
      }
    });

    session = offline.session;
    reconnectionHandle = offline.reconnectionHandle;
    reportedSessionId = response ? response.id : null;
  }

  primeAgentStateForUi(session, '[gemini]');

  if (reportedSessionId) {
    await persistTerminalAttachmentInfoIfNeeded({ sessionId: reportedSessionId, terminal });
    sendTerminalFallbackMessageIfNeeded({ session, terminal });
    await reportSessionToDaemonIfRunning({ sessionId: reportedSessionId, metadata });
  }

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Conversation history for context preservation across model changes
  const conversationHistory = new ConversationHistory({ maxMessages: 20, maxCharacters: 50000 });

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
  let currentModel: string | undefined = undefined;

  session.onUserMessage((message) => {
    // Resolve permission mode (validate) - same as Codex
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      if (CODEX_GEMINI_PERMISSION_MODES.includes(message.meta.permissionMode as CodexGeminiPermissionMode)) {
        const nextPermissionMode = message.meta.permissionMode as PermissionMode;
        const res = maybeUpdatePermissionModeMetadata({
          currentPermissionMode,
          nextPermissionMode,
          updateMetadata: (updater) => session.updateMetadata(updater),
        });
        currentPermissionMode = res.currentPermissionMode;
        messagePermissionMode = currentPermissionMode;
        if (res.didChange) {
          // Update permission handler with new mode
          updatePermissionMode(messagePermissionMode);
          logger.debug(`[Gemini] Permission mode updated from user message to: ${currentPermissionMode}`);
        }
      } else {
        logger.debug(`[Gemini] Invalid permission mode received: ${message.meta.permissionMode}`);
      }
    } else {
      logger.debug(`[Gemini] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
    }

    // Resolve model; explicit null resets to default (undefined)
    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      // If model is explicitly null, reset internal state but don't update displayed model
      // If model is provided, use it and update displayed model
      // Otherwise keep current model
      if (message.meta.model === null) {
        messageModel = undefined; // Explicitly reset - will use default/env/config
        currentModel = undefined;
        // Don't call updateDisplayedModel here - keep current displayed model
        // The backend will use the correct model from env/config/default
      } else if (message.meta.model) {
        const previousModel = currentModel;
        messageModel = message.meta.model;
        currentModel = messageModel;
        // Only update UI and show message if model actually changed
        if (previousModel !== messageModel) {
          // Save model to config file so it persists across sessions
          updateDisplayedModel(messageModel, true); // Update UI and save to config
          // Show model change message in UI (this will trigger UI re-render)
          messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
          logger.debug(`[Gemini] Model changed from ${previousModel} to ${messageModel}`);
        }
      }
      // If message.meta.model is undefined, keep currentModel
    }

    // Build the full prompt with appendSystemPrompt if provided
    // Only include system prompt for the first message to avoid forcing tool usage on every message
    const originalUserMessage = message.content.text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && message.meta?.appendSystemPrompt) {
      // Prepend system prompt to user message only for first message
      // Also add change_title instruction (like Codex does)
      // Use EXACT same format as Codex: add instruction AFTER user message
      // This matches Codex's approach exactly - instruction comes after user message
      // Codex format: system prompt + user message + change_title instruction
      fullPrompt = message.meta.appendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
      isFirstMessage = false;
    }

    const mode: GeminiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
      originalUserMessage, // Store original message separately
    };
    messageQueue.push(fullPrompt, mode);
    
    // Record user message in conversation history for context preservation
    conversationHistory.addUserMessage(originalUserMessage);
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
        'Gemini is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Gemini] Failed to send ready push', pushError);
    }
  };

  /**
   * Check if we can emit ready event
   * * Returns true when ready event was emitted
   */
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
  let geminiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;
  let wasSessionCreated = false;
  let storedResumeId: string | null = (() => {
    const raw = typeof opts.resume === 'string' ? opts.resume.trim() : '';
    return raw ? raw : null;
  })();

  const lastGeminiSessionIdPublished: { value: string | null } = { value: null };

  async function handleAbort() {
    logger.debug('[Gemini] Abort requested - stopping current task');
    
    // Send turn_aborted event (like Codex) when abort is requested
    session.sendAgentMessage('gemini', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    // Abort reasoning processor and reset diff processor
    reasoningProcessor.abort();
    diffProcessor.reset();
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (geminiBackend && acpSessionId) {
        await geminiBackend.cancel(acpSessionId);
      }
      logger.debug('[Gemini] Abort completed - session remains active');
    } catch (error) {
      logger.debug('[Gemini] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Gemini] Kill session requested - terminating process');
    await handleAbort();
    logger.debug('[Gemini] Abort completed, proceeding with termination');

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

      if (geminiBackend) {
        await geminiBackend.dispose();
      }

      logger.debug('[Gemini] Session termination complete, exiting');
      process.exit(0);
    } catch (error) {
      logger.debug('[Gemini] Error during session termination:', error);
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
  // Initialize with env var or default to show correct model from start
  let displayedModel: string | undefined = getInitialGeminiModel();
  
  // Log initial values
  const localConfig = readGeminiLocalConfig();
  logger.debug(`[gemini] Initial model setup: env[GEMINI_MODEL_ENV]=${process.env[GEMINI_MODEL_ENV] || 'not set'}, localConfig=${localConfig.model || 'not set'}, displayedModel=${displayedModel}`);

  // Function to update displayed model and notify UI
  const updateDisplayedModel = (model: string | undefined, saveToConfig: boolean = false) => {
    // Only update if model is actually provided (not undefined)
    if (model === undefined) {
      logger.debug(`[gemini] updateDisplayedModel called with undefined, skipping update`);
      return;
    }
    
    const oldModel = displayedModel;
    displayedModel = model;
    logger.debug(`[gemini] updateDisplayedModel called: oldModel=${oldModel}, newModel=${model}, saveToConfig=${saveToConfig}`);
    
    // Save to config file if requested (when user changes model via mobile app)
    if (saveToConfig) {
      saveGeminiModelToConfig(model);
    }
    
    // Trigger UI update by adding a system message with model info
    // The message will be parsed by UI to extract model name
    if (hasTTY && oldModel !== model) {
      // Add a system message that includes model info - UI will parse it
      // Format: [MODEL:gemini-2.5-pro] to make it easy to extract
      logger.debug(`[gemini] Adding model update message to buffer: [MODEL:${model}]`);
      messageBuffer.addMessage(`[MODEL:${model}]`, 'system');
    } else if (hasTTY) {
      logger.debug(`[gemini] Model unchanged, skipping update message`);
    }
  };

  if (hasTTY) {
    console.clear();
    // Create a React component that reads displayedModel from closure
    // Model will update when UI re-renders (on messageBuffer updates)
    // We use a function component that reads displayedModel on each render
    const DisplayComponent = () => {
      // Read displayedModel from closure - it will have latest value on each render
      const currentModelValue = displayedModel || 'gemini-2.5-pro';
      // Don't log on every render to avoid spam - only log when model changes
      return React.createElement(GeminiTerminalDisplay, {
        messageBuffer,
        logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
        currentModel: currentModelValue,
        onExit: async () => {
          logger.debug('[gemini]: Exiting agent via Ctrl-C');
          shouldExit = true;
          await handleAbort();
        }
      });
    };
    
    inkInstance = render(React.createElement(DisplayComponent), {
      exitOnCtrlC: false,
      patchConsole: false
    });
    
    // Send initial model to UI so it displays correctly from start
    const initialModelName = displayedModel || 'gemini-2.5-pro';
    logger.debug(`[gemini] Sending initial model to UI: ${initialModelName}`);
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
  // Start Happy MCP server and create Gemini backend
  //

  const happyServer = await startHappyServer(session);
  const bridgeScript = join(projectPath(), 'bin', 'happy-mcp.mjs');
  // Use process.execPath (bun or node) as command to support both runtimes
  const mcpServers = {
    happy: {
      command: process.execPath,
      args: [bridgeScript, '--url', happyServer.url]
    }
  };

  // Create permission handler for tool approval (variable declared earlier for onSessionSwap)
  permissionHandler = new GeminiPermissionHandler(session, { onAbortRequested: handleAbort });
  
  // Create reasoning processor for handling thinking/reasoning chunks
  const reasoningProcessor = new GeminiReasoningProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendAgentMessage('gemini', message);
  });
  
  // Create diff processor for handling file edit events and diff tracking
  const diffProcessor = new GeminiDiffProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendAgentMessage('gemini', message);
  });
  
  // Update permission handler when permission mode changes
  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };

  // Accumulate Gemini response text for sending complete message to mobile
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let currentResponseMessageId: string | null = null; // Track the message ID for current response
  let hadToolCallInTurn = false; // Track if any tool calls happened in this turn (for task_complete)
  let pendingChangeTitle = false; // Track if we're waiting for change_title to complete
  let changeTitleCompleted = false; // Track if change_title was completed in this turn
  let taskStartedSent = false; // Track if task_started was sent this turn (prevent duplicates)

  /**
   * Set up message handler for Gemini backend
   * This function is called when backend is created or recreated
   */
  function setupGeminiMessageHandler(backend: AgentBackend): void {
    backend.onMessage((msg: AgentMessage) => {

    switch (msg.type) {
      case 'model-output':
        if (msg.textDelta) {
          const delta = msg.textDelta;
          const wasInProgress = isResponseInProgress;
          handleAcpModelOutputDelta({
            delta,
            messageBuffer,
            getIsResponseInProgress: () => isResponseInProgress,
            setIsResponseInProgress: (value) => { isResponseInProgress = value; },
            appendToAccumulatedResponse: (d) => { accumulatedResponse += d; },
          });
          if (!wasInProgress) {
            logger.debug(`[gemini] Started new response, first chunk length: ${delta.length}`);
          } else {
            logger.debug(`[gemini] Updated response, chunk length: ${delta.length}, total accumulated: ${accumulatedResponse.length}`);
          }
        }
        break;

      case 'status':
        // Log status changes for debugging - stringify object details
        const statusDetail = msg.detail 
          ? (typeof msg.detail === 'object' ? JSON.stringify(msg.detail) : String(msg.detail))
          : '';
        logger.debug(`[gemini] Status changed: ${msg.status}${statusDetail ? ` - ${statusDetail}` : ''}`);
        
        // Log error status with details
        if (msg.status === 'error') {
          logger.debug(`[gemini] ⚠️ Error status received: ${statusDetail || 'Unknown error'}`);
          
          // Send turn_aborted event (like Codex) when error occurs
          session.sendAgentMessage('gemini', {
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }
        
        if (msg.status === 'running') {
          handleAcpStatusRunning({
            session,
            agent: 'gemini',
            messageBuffer,
            onThinkingChange: (value) => { thinking = value; },
            getTaskStartedSent: () => taskStartedSent,
            setTaskStartedSent: (value) => { taskStartedSent = value; },
            makeId: () => randomUUID(),
          });
          
          // Don't reset accumulator here - tool calls can happen during a response
          // Accumulator will be reset when a new prompt is sent (in the main loop)
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          // DON'T change thinking state here - Gemini makes pauses between chunks
          // which causes multiple idle events. thinking will be set to false ONCE
          // in the finally block when the turn is complete.
          // This prevents UI status flickering between "working" and "online"
          
          // Complete reasoning processor when status becomes idle (like Codex)
          // Only complete if there's actually reasoning content to complete
          // Skip if this is just the initial idle status after session creation
          reasoningProcessor.complete();
        } else if (msg.status === 'error') {
          thinking = false;
          session.keepAlive(thinking, 'remote');
          accumulatedResponse = '';
          isResponseInProgress = false;
          currentResponseMessageId = null;
          
          // Show error in CLI UI - handle object errors properly
          let errorMessage = 'Unknown error';
          if (msg.detail) {
            if (typeof msg.detail === 'object') {
              // Extract message from error object
              const detailObj = msg.detail as Record<string, unknown>;
              errorMessage = (detailObj.message as string) || 
                           (detailObj.details as string) || 
                           JSON.stringify(detailObj);
            } else {
              errorMessage = String(msg.detail);
            }
          }
          
          // Check for authentication error and provide helpful message
          if (errorMessage.includes('Authentication required')) {
            errorMessage = `Authentication required.\n` +
              `For Google Workspace accounts, run: happy gemini project set <project-id>\n` +
              `Or use a different Google account: happy connect gemini\n` +
              `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`;
          }
          
          messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          
          // Use sendAgentMessage for consistency with ACP format
          session.sendAgentMessage('gemini', {
            type: 'message',
            message: `Error: ${errorMessage}`,
          });
        }
        break;

      case 'tool-call':
        // Track that we had tool calls in this turn (for task_complete)
        hadToolCallInTurn = true;
        
        // Show tool call in UI like Codex does
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        const isInvestigationTool = msg.toolName === 'codebase_investigator' || 
                                    (typeof msg.toolName === 'string' && msg.toolName.includes('investigator'));
        
        logger.debug(`[gemini] 🔧 Tool call received: ${msg.toolName} (${msg.callId})${isInvestigationTool ? ' [INVESTIGATION]' : ''}`);
        if (isInvestigationTool && msg.args && typeof msg.args === 'object' && 'objective' in msg.args) {
          logger.debug(`[gemini] 🔍 Investigation objective: ${String(msg.args.objective).substring(0, 150)}...`);
        }
        
        messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;

      case 'tool-result':
        // Track change_title completion
        if (msg.toolName === 'change_title' || 
            msg.callId?.includes('change_title') ||
            msg.toolName === 'happy__change_title') {
          changeTitleCompleted = true;
          logger.debug('[gemini] change_title completed');
        }

        const isStreamingChunk =
          !!msg.result
          && typeof msg.result === 'object'
          && (msg.result as any)._stream === true
          && (typeof (msg.result as any).stdoutChunk === 'string' || typeof (msg.result as any).stderrChunk === 'string');
        
	        // Show tool result in UI like Codex does
	        // Check if result contains error information
	        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
	        const resultText = msg.result == null
	          ? '(no output)'
	          : typeof msg.result === 'string'
	            ? msg.result.substring(0, 200)
	            : JSON.stringify(msg.result).substring(0, 200);
	        const truncatedResult = resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');
	        
	        const resultSize = typeof msg.result === 'string' 
	          ? msg.result.length 
	          : msg.result == null ? 0 : JSON.stringify(msg.result).length;
        
        logger.debug(`[gemini] ${isError ? '❌' : '✅'} Tool result received: ${msg.toolName} (${msg.callId}) - Size: ${resultSize} bytes${isError ? ' [ERROR]' : ''}`);
        
        // Process tool result through diff processor to check for diff information (like Codex)
        if (!isError && !isStreamingChunk) {
          diffProcessor.processToolResult(msg.toolName, msg.result, msg.callId);
        }
        
        if (isStreamingChunk) {
          // Avoid spamming the terminal UI for streamed tool result chunks; the mobile UI
          // will append these to the active tool as incremental output.
        } else if (isError) {
          const errorMsg = (msg.result as any).error || 'Tool call failed';
          logger.debug(`[gemini] ❌ Tool call error: ${errorMsg.substring(0, 300)}`);
          messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
        } else {
          // Log summary for large results (like investigation tools)
          if (resultSize > 1000) {
            logger.debug(`[gemini] ✅ Large tool result (${resultSize} bytes) - first 200 chars: ${truncatedResult}`);
          }
          messageBuffer.addMessage(`Result: ${truncatedResult}`, 'result');
        }
        
        session.sendAgentMessage('gemini', {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: randomUUID(),
        });
        break;

      case 'fs-edit':
        messageBuffer.addMessage(`File edit: ${msg.description}`, 'tool');
        
        // Process fs-edit through diff processor (like Codex)
        // msg.diff is optional (diff?: string), so it can be undefined
        diffProcessor.processFsEdit(msg.path || '', msg.description, msg.diff);
        
        session.sendAgentMessage('gemini', {
          type: 'file-edit',
          description: msg.description,
          diff: msg.diff,
          filePath: msg.path || 'unknown',
          id: randomUUID(),
        });
        break;

      default:
        // Handle token-count and other potential message types
        if ((msg as any).type === 'token-count') {
          // Forward token count to mobile app (like Codex)
          // Note: Gemini ACP may not provide token_count events directly,
          // but we handle them if they come from the backend
          session.sendAgentMessage('gemini', {
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;

      case 'terminal-output':
        forwardAcpTerminalOutput({
          msg,
          messageBuffer,
          session,
          agent: 'gemini',
          getCallId: (m) => (m as any).callId || randomUUID(),
        });
        break;

      case 'permission-request':
        forwardAcpPermissionRequest({ msg, session, agent: 'gemini' });
        break;

      case 'exec-approval-request':
        // Handle exec approval request (like Codex exec_approval_request)
        // Convert to tool call for mobile app compatibility
        const execApprovalMsg = msg as any;
        const callId = execApprovalMsg.call_id || execApprovalMsg.callId || randomUUID();
        const { call_id, type, ...inputs } = execApprovalMsg;
        
        logger.debug(`[gemini] Exec approval request received: ${callId}`);
        messageBuffer.addMessage(`Exec approval requested: ${callId}`, 'tool');
        
        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: 'GeminiBash', // Similar to Codex's CodexBash
          callId: callId,
          input: inputs,
          id: randomUUID(),
        });
        break;

      case 'patch-apply-begin':
        // Handle patch operation begin (like Codex patch_apply_begin)
        const patchBeginMsg = msg as any;
        const patchCallId = patchBeginMsg.call_id || patchBeginMsg.callId || randomUUID();
        const { call_id: patchCallIdVar, type: patchType, auto_approved, changes } = patchBeginMsg;
        
        // Add UI feedback for patch operation
        const changeCount = changes ? Object.keys(changes).length : 0;
        const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
        messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        logger.debug(`[gemini] Patch apply begin: ${patchCallId}, files: ${changeCount}`);
        
        session.sendAgentMessage('gemini', {
          type: 'tool-call',
          name: 'GeminiPatch', // Similar to Codex's CodexPatch
          callId: patchCallId,
          input: {
            auto_approved,
            changes
          },
          id: randomUUID(),
        });
        break;

      case 'patch-apply-end':
        // Handle patch operation end (like Codex patch_apply_end)
        const patchEndMsg = msg as any;
        const patchEndCallId = patchEndMsg.call_id || patchEndMsg.callId || randomUUID();
        const { call_id: patchEndCallIdVar, type: patchEndType, stdout, stderr, success } = patchEndMsg;
        
        // Add UI feedback for completion
        if (success) {
          const message = stdout || 'Files modified successfully';
          messageBuffer.addMessage(message.substring(0, 200), 'result');
        } else {
          const errorMsg = stderr || 'Failed to modify files';
          messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
        }
        logger.debug(`[gemini] Patch apply end: ${patchEndCallId}, success: ${success}`);
        
        session.sendAgentMessage('gemini', {
          type: 'tool-result',
          callId: patchEndCallId,
          output: {
            stdout,
            stderr,
            success
          },
          id: randomUUID(),
        });
        break;

      case 'event':
        if (msg.name === 'available_commands_update') {
          const payload = msg.payload as any;
          const details = normalizeAvailableCommands(payload?.availableCommands ?? payload);
          publishSlashCommandsToMetadata({ session, details });
        }
        // Handle thinking events - process through ReasoningProcessor like Codex
        if (msg.name === 'thinking') {
          const thinkingPayload = msg.payload as { text?: string } | undefined;
          const thinkingText = (thinkingPayload && typeof thinkingPayload === 'object' && 'text' in thinkingPayload)
            ? String(thinkingPayload.text || '')
            : '';
          if (thinkingText) {
            // Process thinking chunk through reasoning processor
            // This will identify titled reasoning sections (**Title**) and convert them to tool calls
            reasoningProcessor.processChunk(thinkingText);
            
            // Log thinking chunks (especially useful for investigation tools)
            logger.debug(`[gemini] 💭 Thinking chunk received: ${thinkingText.length} chars - Preview: ${thinkingText.substring(0, 100)}...`);
            
            // Show thinking message in UI (truncated like Codex)
            // For titled reasoning (starts with **), ReasoningProcessor will show it as tool call
            // But we still show progress for long operations
            if (!thinkingText.startsWith('**')) {
              // Update existing "Thinking..." message or add new one for untitled reasoning
              const thinkingPreview = thinkingText.substring(0, 100);
              messageBuffer.updateLastMessage(`[Thinking] ${thinkingPreview}...`, 'system');
            }
            // For titled reasoning, ReasoningProcessor will send tool call, but we keep "Thinking..." visible
            // This ensures user sees progress during long reasoning operations
          }
          // Also forward to mobile for UI feedback
          session.sendAgentMessage('gemini', {
            type: 'thinking',
            text: thinkingText,
          });
        }
        break;
    }
    });
  }

  // Note: Backend will be created dynamically in the main loop based on model from first message
  // This allows us to support model changes by recreating the backend

  let first = true;

  try {
    let currentModeHash: string | null = null;
    let pending: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = null;

    while (!shouldExit) {
      let message: { message: string; mode: GeminiMode; isolate: boolean; hash: string } | null = pending;
      pending = null;

      if (!message) {
        logger.debug('[gemini] Main loop: waiting for messages from queue...');
        const waitSignal = abortController.signal;
        const batch = await waitForMessagesOrPending({
          messageQueue,
          abortSignal: waitSignal,
          popPendingMessage: () => session.popPendingMessage(),
          waitForMetadataUpdate: (signal) => session.waitForMetadataUpdate(signal),
        });
        if (!batch) {
          if (waitSignal.aborted && !shouldExit) {
            logger.debug('[gemini] Main loop: wait aborted, continuing...');
            continue;
          }
          logger.debug('[gemini] Main loop: no batch received, breaking...');
          break;
        }
        logger.debug(`[gemini] Main loop: received message from queue (length: ${batch.message.length})`);
        message = batch;
      }

      if (!message) {
        break;
      }

      // Track if we need to inject conversation history (after model change)
      let injectHistoryContext = false;
      
      // Handle mode change (like Codex) - restart session if permission mode or model changed
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[Gemini] Mode changed – restarting Gemini session');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        
        // Check if we have conversation history to preserve
        if (conversationHistory.hasHistory()) {
          messageBuffer.addMessage(`Switching model (preserving ${conversationHistory.size()} messages of context)...`, 'status');
          injectHistoryContext = true;
          logger.debug(`[Gemini] Will inject conversation history: ${conversationHistory.getSummary()}`);
        } else {
          messageBuffer.addMessage('Starting new Gemini session (mode changed)...', 'status');
        }
        
        // Reset permission handler and reasoning processor on mode change (like Codex)
        permissionHandler.reset();
        reasoningProcessor.abort();
        
        // Dispose old backend and create new one with new model
        if (geminiBackend) {
          await geminiBackend.dispose();
          geminiBackend = null;
        }

        // Create new backend with new model
        const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
        const backendResult = (await createCatalogAcpBackend<GeminiBackendOptions, GeminiBackendResult>('gemini', {
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          cloudToken,
          currentUserEmail,
          // Pass model from message - if undefined, will use local config/env/default
          // If explicitly null, will skip local config and use env/default
          model: modelToUse,
        })) as GeminiBackendResult;
        geminiBackend = backendResult.backend;

        // Set up message handler again
        setupGeminiMessageHandler(geminiBackend);

        // Use model from factory result (single source of truth - no duplicate resolution)
        const actualModel = backendResult.model;
        logger.debug(`[gemini] Model change - modelToUse=${modelToUse}, actualModel=${actualModel} (from ${backendResult.modelSource})`);
        
        // Update conversation history with new model
        conversationHistory.setCurrentModel(actualModel);
        
        logger.debug('[gemini] Starting new ACP session with model:', actualModel);
        const { sessionId } = await geminiBackend.startSession();
        acpSessionId = sessionId;
        logger.debug(`[gemini] New ACP session started: ${acpSessionId}`);
        maybeUpdateGeminiSessionIdMetadata({
          getGeminiSessionId: () => acpSessionId,
          updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
          lastPublished: lastGeminiSessionIdPublished,
        });
        
        // Update displayed model in UI (don't save to config - this is backend initialization)
        logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
        updateDisplayedModel(actualModel, false);
        // Don't add "Using model" message - model is shown in status bar
        
        // Update permission handler with current permission mode
        updatePermissionMode(message.mode.permissionMode);
        
        wasSessionCreated = true;
        currentModeHash = message.hash;
        first = false; // Not first message anymore
      }

      currentModeHash = message.hash;
      // Show only original user message in UI, not the full prompt with system prompt
      const userMessageToShow = message.mode?.originalUserMessage || message.message;
      messageBuffer.addMessage(userMessageToShow, 'user');

      // Mark that we're processing a message to synchronize session swaps
      isProcessingMessage = true;

      try {
        if (first || !wasSessionCreated) {
          // First message or session not created yet - create backend and start session
          if (!geminiBackend) {
            const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
            const backendResult = (await createCatalogAcpBackend<GeminiBackendOptions, GeminiBackendResult>('gemini', {
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              cloudToken,
              currentUserEmail,
              // Pass model from message - if undefined, will use local config/env/default
              // If explicitly null, will skip local config and use env/default
              model: modelToUse,
            })) as GeminiBackendResult;
            geminiBackend = backendResult.backend;

            // Set up message handler
            setupGeminiMessageHandler(geminiBackend);

            // Use model from factory result (single source of truth - no duplicate resolution)
            const actualModel = backendResult.model;
            logger.debug(`[gemini] Backend created, model will be: ${actualModel} (from ${backendResult.modelSource})`);
            logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
            updateDisplayedModel(actualModel, false); // Don't save - this is backend initialization
            
            // Track current model in conversation history
            conversationHistory.setCurrentModel(actualModel);
          }
          
          // Start session if not started
          if (!acpSessionId) {
            logger.debug('[gemini] Starting ACP session...');
            // Update permission handler with current permission mode before starting session
            updatePermissionMode(message.mode.permissionMode);
            const resumeId = storedResumeId;
            if (resumeId) {
              if (!geminiBackend.loadSession) {
                throw new Error('Gemini ACP backend does not support loading sessions');
              }
              storedResumeId = null; // consume once
              messageBuffer.addMessage('Resuming previous context…', 'status');
              const loadWithReplay = (geminiBackend as any).loadSessionWithReplayCapture as undefined | ((id: string) => Promise<{ sessionId: string; replay: any[] }>);
              let replay: any[] | null = null;
              if (loadWithReplay) {
                const loaded = await loadWithReplay(resumeId);
                replay = Array.isArray(loaded.replay) ? loaded.replay : null;
                const loadedSessionId =
                  typeof loaded.sessionId === 'string' && loaded.sessionId.trim().length > 0
                    ? loaded.sessionId.trim()
                    : resumeId;
                acpSessionId = loadedSessionId;
              } else {
                await geminiBackend.loadSession(resumeId);
                acpSessionId = resumeId;
              }
              logger.debug(`[gemini] ACP session loaded: ${acpSessionId}`);

              if (replay) {
                void importAcpReplayHistoryV1({
                  session,
                  provider: 'gemini',
                  remoteSessionId: acpSessionId,
                  replay,
                  permissionHandler,
                });
              }
            } else {
              const { sessionId } = await geminiBackend.startSession();
              acpSessionId = sessionId;
              logger.debug(`[gemini] ACP session started: ${acpSessionId}`);
            }
            maybeUpdateGeminiSessionIdMetadata({
              getGeminiSessionId: () => acpSessionId,
              updateHappySessionMetadata: (updater) => session.updateMetadata(updater),
              lastPublished: lastGeminiSessionIdPublished,
            });
            wasSessionCreated = true;
            currentModeHash = message.hash;
            
            // Model info is already shown in status bar via updateDisplayedModel
            logger.debug(`[gemini] Displaying model in UI: ${displayedModel || 'gemini-2.5-pro'}, displayedModel: ${displayedModel}`);
          }
        }
        
        if (!acpSessionId) {
          throw new Error('ACP session not started');
        }
         
        // Reset accumulator when sending a new prompt (not when tool calls start)
        // Reset accumulated response for new prompt
        // This ensures a new assistant message will be created (not updating previous one)
        accumulatedResponse = '';
        isResponseInProgress = false;
        hadToolCallInTurn = false;
        taskStartedSent = false; // Reset so new turn can send task_started
        
        // Track if this prompt contains change_title instruction
        // If so, don't send task_complete until change_title is completed
        pendingChangeTitle = message.message.includes('change_title') || 
                             message.message.includes('happy__change_title');
        changeTitleCompleted = false;
        
        if (!geminiBackend || !acpSessionId) {
          throw new Error('Gemini backend or session not initialized');
        }
        
        // The prompt already includes system prompt and change_title instruction (added in onUserMessage handler)
        // This is done in the message queue, so message.message already contains everything
        let promptToSend = message.message;
        
        // Inject conversation history context if model was just changed
        if (injectHistoryContext && conversationHistory.hasHistory()) {
          const historyContext = conversationHistory.getContextForNewSession();
          promptToSend = historyContext + promptToSend;
          logger.debug(`[gemini] Injected conversation history context (${historyContext.length} chars)`);
          // Don't clear history - keep accumulating for future model changes
        }
        
        logger.debug(`[gemini] Sending prompt to Gemini (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);
        logger.debug(`[gemini] Full prompt: ${promptToSend}`);
        
        // Retry logic for transient Gemini API errors (empty response, internal errors)
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;
        let lastError: unknown = null;
        
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await geminiBackend.sendPrompt(acpSessionId, promptToSend);
            logger.debug('[gemini] Prompt sent successfully');
            
            // Wait for Gemini to finish responding (all chunks received + final idle)
            // This ensures we don't send task_complete until response is truly done
            if (geminiBackend.waitForResponseComplete) {
              await geminiBackend.waitForResponseComplete(120000);
              logger.debug('[gemini] Response complete');
            }
            
            break; // Success, exit retry loop
          } catch (promptError) {
            lastError = promptError;
            const errObj = promptError as any;
            const errorDetails = errObj?.data?.details || errObj?.details || errObj?.message || '';
            const errorCode = errObj?.code;
            
            // Check for quota exhausted - this is NOT retryable
            const isQuotaError = errorDetails.includes('exhausted') || 
                                 errorDetails.includes('quota') ||
                                 errorDetails.includes('capacity');
            if (isQuotaError) {
              // Extract reset time from error message like "Your quota will reset after 3h20m35s."
              const resetTimeMatch = errorDetails.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
              let resetTimeMsg = '';
              if (resetTimeMatch) {
                const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
                resetTimeMsg = ` Quota resets in ${parts}.`;
              }
              const quotaMsg = `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
              messageBuffer.addMessage(quotaMsg, 'status');
              session.sendAgentMessage('gemini', { type: 'message', message: quotaMsg });
              throw promptError; // Don't retry quota errors
            }
            
            // Check if this is a retryable error (empty response, internal error -32603)
            const isEmptyResponseError = errorDetails.includes('empty response') || 
                                         errorDetails.includes('Model stream ended');
            const isInternalError = errorCode === -32603;
            const isRetryable = isEmptyResponseError || isInternalError;
            
            if (isRetryable && attempt < MAX_RETRIES) {
              logger.debug(`[gemini] Retryable error on attempt ${attempt}/${MAX_RETRIES}: ${errorDetails}`);
              messageBuffer.addMessage(`Gemini returned empty response, retrying (${attempt}/${MAX_RETRIES})...`, 'status');
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
              continue;
            }
            
            // Not retryable or max retries reached
            throw promptError;
          }
        }
        
        if (lastError && MAX_RETRIES > 1) {
          // If we had errors but eventually succeeded, log it
          logger.debug('[gemini] Prompt succeeded after retries');
        }
        
        // Mark as not first message after sending prompt
        if (first) {
          first = false;
        }
      } catch (error) {
        logger.debug('[gemini] Error in gemini session:', error);
        const isAbortError = error instanceof Error && error.name === 'AbortError';

        if (isAbortError) {
          messageBuffer.addMessage('Aborted by user', 'status');
          session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
        } else {
          const errorMsg = formatGeminiErrorForUi(error, displayedModel);
          
          messageBuffer.addMessage(errorMsg, 'status');
          // Use sendAgentMessage for consistency with ACP format
          session.sendAgentMessage('gemini', {
            type: 'message',
            message: errorMsg,
          });
        }
      } finally {
        // Reset permission handler, reasoning processor, and diff processor after turn (like Codex)
        permissionHandler.reset();
        reasoningProcessor.abort(); // Use abort to properly finish any in-progress tool calls
        diffProcessor.reset(); // Reset diff processor on turn completion
        
        // Send accumulated response to mobile app ONLY when turn is complete
        // This prevents message fragmentation from Gemini's chunked responses
        if (accumulatedResponse.trim()) {
          const { text: messageText, options } = parseOptionsFromText(accumulatedResponse);
          
          // Record assistant response in conversation history for context preservation
          conversationHistory.addAssistantMessage(messageText);
          
          // Mobile app parses options from text via parseMarkdown
          let finalMessageText = messageText;
          if (options.length > 0) {
            const optionsXml = formatOptionsXml(options);
            finalMessageText = messageText + optionsXml;
            logger.debug(`[gemini] Found ${options.length} options in response:`, options);
          } else if (hasIncompleteOptions(accumulatedResponse)) {
            logger.debug(`[gemini] Warning: Incomplete options block detected`);
          }
          
          const messagePayload: CodexMessagePayload = {
            type: 'message',
            message: finalMessageText,
            id: randomUUID(),
            ...(options.length > 0 && { options }),
          };
          
          logger.debug(`[gemini] Sending complete message to mobile (length: ${finalMessageText.length}): ${finalMessageText.substring(0, 100)}...`);
          session.sendAgentMessage('gemini', messagePayload);
          accumulatedResponse = '';
          isResponseInProgress = false;
        }
        
        // Send task_complete ONCE at the end of turn (not on every idle)
        // This signals to the UI that the agent has finished processing
        session.sendAgentMessage('gemini', {
          type: 'task_complete',
          id: randomUUID(),
        });
        
        // Reset tracking flags
        hadToolCallInTurn = false;
        pendingChangeTitle = false;
        changeTitleCompleted = false;
        taskStartedSent = false;
        
        thinking = false;
        session.keepAlive(thinking, 'remote');
        
        const popped = !shouldExit ? await session.popPendingMessage() : false;
        if (!popped) {
          // Use same logic as Codex - emit ready if idle (no pending operations, no queue)
          emitReadyIfIdle();
        }

        // Message processing complete - safe to apply any pending session swap
        isProcessingMessage = false;
        applyPendingSessionSwap();

        logger.debug(`[gemini] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Clean up resources
    logger.debug('[gemini]: Final cleanup start');

    // Cancel offline reconnection if still running
    if (reconnectionHandle) {
      logger.debug('[gemini]: Cancelling offline reconnection');
      reconnectionHandle.cancel();
    }

    try {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (e) {
      logger.debug('[gemini]: Error while closing session', e);
    }

    if (geminiBackend) {
      await geminiBackend.dispose();
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

    logger.debug('[gemini]: Final cleanup completed');
  }
}
