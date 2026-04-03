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
import { join } from 'node:path';

import { ApiClient } from '@/api/api';
import { SyncBridge } from '@/api/syncBridge';
import { resolveSessionScopedSyncNodeToken } from '@/api/syncNodeToken';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
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
import type { SessionID } from '@slopus/happy-sync';
import {
  applyPseudoEventToAcpxTurn,
  createAcpxTurn,
  getUserMessageText,
  hasAcpxTurnContent,
  resetAcpxTurn,
} from '@/session/acpxTurn';

import { createGeminiBackend } from '@/agent/factories/gemini';
import type { AgentBackend, AgentMessage } from '@/agent';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { GeminiMode, CodexMessagePayload } from '@/gemini/types';
import type { PermissionMode } from '@/api/types';
import { GEMINI_MODEL_ENV, DEFAULT_GEMINI_MODEL, CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
  readGeminiLocalConfig,
  saveGeminiModelToConfig,
  getInitialGeminiModel
} from '@/gemini/utils/config';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/gemini/utils/optionsParser';
import { ConversationHistory } from '@/gemini/utils/conversationHistory';


/**
 * Main entry point for the gemini command with ink UI
 */
export async function runGemini(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
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
  const sandboxConfig = settings?.sandboxConfig;
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

  const { state, metadata } = createSessionMetadata({
    flavor: 'gemini',
    machineId,
    startedBy: opts.startedBy,
    sandbox: sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable case
  if (!response) {
    logger.debug('[Gemini] Server unreachable, exiting');
    console.error('Server unreachable. Please check your connection and try again.');
    process.exit(1);
  }

  // Keep ApiSessionClient around for operations not yet in SyncBridge (sendAgentMessage, etc.)
  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    }
  });
  session = initialSession;

  // Permission handler declared here so it can be referenced before assignment
  let permissionHandler: GeminiPermissionHandler;

  // Session swap synchronization to prevent race conditions during message processing
  let isProcessingMessage = false;

  // ─── Create SyncBridge directly (primary transport) ──────────────────────

  const sessionScopedToken = await resolveSessionScopedSyncNodeToken({
    serverUrl: configuration.serverUrl,
    sessionId: response.id,
    token: {
      raw: opts.credentials.token,
      claims: {
        scope: { type: 'account', userId: 'cli' },
        permissions: ['read', 'write', 'admin'],
      },
    },
  });

  const syncBridge = new SyncBridge({
    serverUrl: configuration.serverUrl,
    token: sessionScopedToken,
    keyMaterial: {
      key: response.encryptionKey,
      variant: response.encryptionVariant,
    },
    sessionId: response.id as SessionID,
  });

  await syncBridge.connect();
  logger.debug('[START] SyncBridge connected');

  const geminiTurn = createAcpxTurn();

  function publishGeminiTurn(): void {
    if (!hasAcpxTurnContent(geminiTurn)) return;
    if (geminiTurn.sent) {
      syncBridge.updateMessage(geminiTurn.message).catch((err) => {
        logger.debug('[gemini] acpx update failed', { error: err });
      });
      return;
    }
    geminiTurn.sent = true;
    syncBridge.sendMessage(geminiTurn.message).catch((err) => {
      logger.debug('[gemini] acpx send failed', { error: err });
    });
  }

  function resetGeminiTurn(): void {
    resetAcpxTurn(geminiTurn);
  }

  function sendGeminiAcpx(event: Record<string, unknown>): void {
    applyPseudoEventToAcpxTurn(geminiTurn, event);
    publishGeminiTurn();
  }

  // ─── Create RpcHandlerManager and wire to SyncBridge ─────────────────────

  const workingDirectory = process.cwd();

  const rpcHandlerManager = new RpcHandlerManager({
    scopePrefix: response.id,
    encryptionKey: response.encryptionKey,
    encryptionVariant: response.encryptionVariant,
  });

  // Wire RPC: SyncBridge forwards RPC requests to RpcHandlerManager
  syncBridge.setRpcHandler(async (method: string, params: string) => {
    return rpcHandlerManager.handleRequest({ method, params });
  });

  // Auto-register new RPC methods with SyncNode
  rpcHandlerManager.setRegistrationCallback((prefixedMethod) => {
    syncBridge.registerRpcMethods([prefixedMethod]);
  });

  // Register common RPC handlers (bash, readFile, etc.)
  registerCommonHandlers(rpcHandlerManager, workingDirectory);

  // Register all currently known methods with SyncNode
  syncBridge.registerRpcMethods(rpcHandlerManager.getRegisteredMethods());

  // ─── Push notifications ────────────────────────────────────────────────

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

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Conversation history for context preservation across model changes
  const conversationHistory = new ConversationHistory({ maxMessages: 20, maxCharacters: 50000 });

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;
  let currentAppendSystemPrompt: string | undefined = undefined;

  syncBridge.onRuntimeConfigChange((change) => {
    const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
    if (change.permissionMode && validModes.includes(change.permissionMode as PermissionMode)) {
      currentPermissionMode = change.permissionMode as PermissionMode;
      updatePermissionMode(currentPermissionMode);
    }
    if (Object.prototype.hasOwnProperty.call(change, 'model')) {
      currentModel = change.model || undefined;
    }
    if (Object.prototype.hasOwnProperty.call(change, 'appendSystemPrompt')) {
      currentAppendSystemPrompt = change.appendSystemPrompt || undefined;
    }
  });

  syncBridge.onUserMessage((message) => {
    const text = getUserMessageText(message);
    if (!text) return;

    const messagePermissionMode = currentPermissionMode;

    // Initialize permission mode if not set yet
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
    }

    const messageModel = currentModel;

    // Build the full prompt with appendSystemPrompt if provided
    // Only include system prompt for the first message to avoid forcing tool usage on every message
    const originalUserMessage = text;
    let fullPrompt = originalUserMessage;
    if (isFirstMessage && currentAppendSystemPrompt) {
      // Prepend system prompt to user message only for first message
      // Also add change_title instruction (like Codex does)
      // Use EXACT same format as Codex: add instruction AFTER user message
      // This matches Codex's approach exactly - instruction comes after user message
      // Codex format: system prompt + user message + change_title instruction
      fullPrompt = currentAppendSystemPrompt + '\n\n' + originalUserMessage + '\n\n' + CHANGE_TITLE_INSTRUCTION;
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
  syncBridge.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    syncBridge.keepAlive(thinking, 'remote');
  }, 2000);

  // Track if this is the first message to include system prompt only once
  let isFirstMessage = true;

  const sendReady = () => {
    syncBridge.updateAgentState((currentState: any) => ({
      ...currentState,
      lastEvent: { type: 'ready', time: Date.now() },
    }));
    try {
      api.push().sendSessionNotification({
        kind: 'done',
        metadata: session.getMetadata(),
        data: {
          sessionId: session.sessionId,
          type: 'ready',
          provider: 'gemini',
        }
      });
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

  async function handleAbort() {
    logger.debug('[Gemini] Abort requested - stopping current task');
    
    // Send turn_aborted event (like Codex) when abort is requested
    sendGeminiAcpx({
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
      resetGeminiTurn();
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Gemini] Kill session requested - terminating process');
    await handleAbort();
    logger.debug('[Gemini] Abort completed, proceeding with termination');

    try {
      syncBridge.updateMetadata((currentMetadata: any) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'User terminated'
      }));

      resetGeminiTurn();
      syncBridge.sendSessionDeath();
      await syncBridge.flush();
      syncBridge.disconnect();

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

  rpcHandlerManager.registerHandler('abort', handleAbort);
  syncBridge.onAbortRequest(() => {
    void handleAbort();
  });
  registerKillSessionHandler(rpcHandlerManager, handleKillSession);

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
      return React.createElement(GeminiDisplay, {
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

  const happyServer = await startHappyServer({ sessionId: response.id, sendClaudeMessage: (body) => session.sendClaudeSessionMessage(body) });
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create permission handler for tool approval (variable declared earlier)
  permissionHandler = new GeminiPermissionHandler({
    rpcHandlerManager,
    updateAgentState: (handler) => syncBridge.updateAgentState(handler as any),
    sendPermissionRequest: (request) => syncBridge.sendPermissionRequest(request),
  });
  
  // Create reasoning processor for handling thinking/reasoning chunks
  const reasoningProcessor = new GeminiReasoningProcessor((message) => {
    // Callback to send messages directly from the processor
    sendGeminiAcpx(message);
  });
  
  // Create diff processor for handling file edit events and diff tracking
  const diffProcessor = new GeminiDiffProcessor((message) => {
    // Callback to send messages directly from the processor
    sendGeminiAcpx(message);
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
          // If this is the first delta of a new response, create a new message
          // Otherwise, update the existing message for this response
          if (!isResponseInProgress) {
            // Start of new response - create new assistant message
            // Remove "Thinking..." message if it exists (it will be replaced by actual response)
            messageBuffer.removeLastMessage('system'); // Remove "Thinking..." if present
            messageBuffer.addMessage(msg.textDelta, 'assistant');
            isResponseInProgress = true;
            logger.debug(`[gemini] Started new response, first chunk length: ${msg.textDelta.length}`);
          } else {
            // Continue existing response - update last assistant message
            messageBuffer.updateLastMessage(msg.textDelta, 'assistant');
            logger.debug(`[gemini] Updated response, chunk length: ${msg.textDelta.length}, total accumulated: ${accumulatedResponse.length + msg.textDelta.length}`);
          }
          accumulatedResponse += msg.textDelta;
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
          sendGeminiAcpx({
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }
        
        if (msg.status === 'running') {
          thinking = true;
          syncBridge.keepAlive(thinking, 'remote');
          
          // Send task_started event ONCE per turn (like Codex) when agent starts working
          // Gemini may go running -> idle -> running multiple times during a turn
          if (!taskStartedSent) {
            sendGeminiAcpx({
              type: 'task_started',
              id: randomUUID(),
            });
            taskStartedSent = true;
          }
          
          // Show thinking indicator in UI when agent starts working (like Codex)
          // This will be updated with actual thinking text when agent_thought_chunk events arrive
          // Always show thinking indicator when status becomes 'running' to give user feedback
          // Even if response is in progress, we want to show thinking for new operations
          messageBuffer.addMessage('Thinking...', 'system');
          
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
          syncBridge.keepAlive(thinking, 'remote');
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
          sendGeminiAcpx({
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
        sendGeminiAcpx({
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
        
        // Show tool result in UI like Codex does
        // Check if result contains error information
        const isError = msg.result && typeof msg.result === 'object' && 'error' in msg.result;
        const resultText = typeof msg.result === 'string' 
          ? msg.result.substring(0, 200)
          : JSON.stringify(msg.result).substring(0, 200);
        const truncatedResult = resultText + (typeof msg.result === 'string' && msg.result.length > 200 ? '...' : '');
        
        const resultSize = typeof msg.result === 'string' 
          ? msg.result.length 
          : JSON.stringify(msg.result).length;
        
        logger.debug(`[gemini] ${isError ? '❌' : '✅'} Tool result received: ${msg.toolName} (${msg.callId}) - Size: ${resultSize} bytes${isError ? ' [ERROR]' : ''}`);
        
        // Process tool result through diff processor to check for diff information (like Codex)
        if (!isError) {
          diffProcessor.processToolResult(msg.toolName, msg.result, msg.callId);
        }
        
        if (isError) {
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
        
        sendGeminiAcpx({
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
        
        sendGeminiAcpx({
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
          sendGeminiAcpx({
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;

      case 'terminal-output':
        messageBuffer.addMessage(msg.data, 'result');
        sendGeminiAcpx({
          type: 'terminal-output',
          data: msg.data,
          callId: (msg as any).callId || randomUUID(),
        });
        break;

      case 'permission-request':
        // Forward permission request to mobile app
        // Note: toolName is in msg.payload.toolName (from AcpBackend), 
        // msg.reason also contains the tool name
        const payload = (msg as any).payload || {};
        sendGeminiAcpx({
          type: 'permission-request',
          permissionId: msg.id,
          toolName: payload.toolName || (msg as any).reason || 'unknown',
          description: (msg as any).reason || payload.toolName || '',
          options: payload,
        });
        break;

      case 'exec-approval-request':
        // Handle exec approval request (like Codex exec_approval_request)
        // Convert to tool call for mobile app compatibility
        const execApprovalMsg = msg as any;
        const callId = execApprovalMsg.call_id || execApprovalMsg.callId || randomUUID();
        const { call_id, type, ...inputs } = execApprovalMsg;
        
        logger.debug(`[gemini] Exec approval request received: ${callId}`);
        messageBuffer.addMessage(`Exec approval requested: ${callId}`, 'tool');
        
        sendGeminiAcpx({
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
        
        sendGeminiAcpx({
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
        
        sendGeminiAcpx({
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
          sendGeminiAcpx({
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
        const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
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
        const backendResult = createGeminiBackend({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          cloudToken,
          currentUserEmail,
          // Pass model from message - if undefined, will use local config/env/default
          // If explicitly null, will skip local config and use env/default
          model: modelToUse,
        });
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
            const backendResult = createGeminiBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              cloudToken,
              currentUserEmail,
              // Pass model from message - if undefined, will use local config/env/default
              // If explicitly null, will skip local config and use env/default
              model: modelToUse,
            });
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
            const { sessionId } = await geminiBackend.startSession();
            acpSessionId = sessionId;
            logger.debug(`[gemini] ACP session started: ${acpSessionId}`);
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
              sendGeminiAcpx({ type: 'message', message: quotaMsg });
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
          syncBridge.updateAgentState((currentState: any) => ({
            ...currentState,
            lastEvent: { type: 'message', message: 'Aborted by user', time: Date.now() },
          }));
        } else {
          // Parse error message
          let errorMsg = 'Process error occurred';
          
          if (typeof error === 'object' && error !== null) {
            const errObj = error as any;
            
            // Extract error information from various possible formats
            const errorDetails = errObj.data?.details || errObj.details || '';
            const errorCode = errObj.code || errObj.status || (errObj.response?.status);
            const errorMessage = errObj.message || errObj.error?.message || '';
            const errorString = String(error);
            
            // Check for 404 error (model not found)
            if (errorCode === 404 || errorDetails.includes('notFound') || errorDetails.includes('404') || 
                errorMessage.includes('not found') || errorMessage.includes('404')) {
              const currentModel = displayedModel || 'gemini-2.5-pro';
              errorMsg = `Model "${currentModel}" not found. Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite`;
            }
            // Check for empty response / internal error after retries exhausted
            else if (errorCode === -32603 || 
                     errorDetails.includes('empty response') || errorDetails.includes('Model stream ended')) {
              errorMsg = 'Gemini API returned empty response after retries. This is a temporary issue - please try again.';
            }
            // Check for rate limit error (429) - multiple possible formats
            else if (errorCode === 429 || 
                     errorDetails.includes('429') || errorMessage.includes('429') || errorString.includes('429') ||
                     errorDetails.includes('rateLimitExceeded') || errorDetails.includes('RESOURCE_EXHAUSTED') ||
                     errorMessage.includes('Rate limit exceeded') || errorMessage.includes('Resource exhausted') ||
                     errorString.includes('rateLimitExceeded') || errorString.includes('RESOURCE_EXHAUSTED')) {
              errorMsg = 'Gemini API rate limit exceeded. Please wait a moment and try again. The API will retry automatically.';
            }
            // Check for quota/capacity exceeded error
            else if (errorDetails.includes('quota') || errorMessage.includes('quota') || errorString.includes('quota') ||
                     errorDetails.includes('exhausted') || errorDetails.includes('capacity')) {
              // Extract reset time from error message like "Your quota will reset after 3h20m35s."
              const resetTimeMatch = (errorDetails + errorMessage + errorString).match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
              let resetTimeMsg = '';
              if (resetTimeMatch) {
                const parts = resetTimeMatch.slice(1).filter(Boolean).join('');
                resetTimeMsg = ` Quota resets in ${parts}.`;
              }
              errorMsg = `Gemini quota exceeded.${resetTimeMsg} Try using a different model (gemini-2.5-flash-lite) or wait for quota reset.`;
            }
            // Check for authentication error (Google Workspace accounts need project ID)
            else if (errorMessage.includes('Authentication required') || 
                     errorDetails.includes('Authentication required') ||
                     errorCode === -32000) {
              errorMsg = `Authentication required. For Google Workspace accounts, you need to set a Google Cloud Project:\n` +
                         `  happy gemini project set <your-project-id>\n` +
                         `Or use a different Google account: happy connect gemini\n` +
                         `Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca`;
            }
            // Check for empty error (command not found)
            else if (Object.keys(error).length === 0) {
              errorMsg = 'Failed to start Gemini. Is "gemini" CLI installed? Run: npm install -g @google/gemini-cli';
            }
            // Use message from error object
            else if (errObj.message || errorMessage) {
              errorMsg = errorDetails || errorMessage || errObj.message;
            }
          } else if (error instanceof Error) {
            errorMsg = error.message;
          }
          
          messageBuffer.addMessage(errorMsg, 'status');
          // Use sendAgentMessage for consistency with ACP format
          sendGeminiAcpx({
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
          
          const messagePayload = {
            type: 'message' as const,
            message: finalMessageText,
            id: randomUUID(),
            ...(options.length > 0 && { options }),
          };

          logger.debug(`[gemini] Sending complete message to mobile (length: ${finalMessageText.length}): ${finalMessageText.substring(0, 100)}...`);
          sendGeminiAcpx(messagePayload);
          accumulatedResponse = '';
          isResponseInProgress = false;
        }
        
        // Send task_complete ONCE at the end of turn (not on every idle)
        // This signals to the UI that the agent has finished processing
        sendGeminiAcpx({
          type: 'task_complete',
          id: randomUUID(),
        });
        
        // Reset tracking flags
        hadToolCallInTurn = false;
        pendingChangeTitle = false;
        changeTitleCompleted = false;
        taskStartedSent = false;
        resetGeminiTurn();
        
        thinking = false;
        syncBridge.keepAlive(thinking, 'remote');

        // Use same logic as Codex - emit ready if idle (no pending operations, no queue)
        emitReadyIfIdle();

        // Message processing complete
        isProcessingMessage = false;

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
      resetGeminiTurn();
      syncBridge.sendSessionDeath();
      await syncBridge.flush();
      syncBridge.disconnect();
    } catch (e) {
      logger.debug('[gemini]: Error while closing SyncBridge', e);
    }

    try {
      await session.close();
    } catch (e) {
      logger.debug('[gemini]: Error while closing legacy session', e);
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
