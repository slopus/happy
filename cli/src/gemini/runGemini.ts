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
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';

import { createGeminiBackend } from '@/agent/acp/gemini';
import type { AgentBackend, AgentMessage } from '@/agent/AgentBackend';
import { GeminiDisplay } from '@/ui/ink/GeminiDisplay';
import { GeminiPermissionHandler } from '@/gemini/utils/permissionHandler';
import { GeminiReasoningProcessor } from '@/gemini/utils/reasoningProcessor';
import { GeminiDiffProcessor } from '@/gemini/utils/diffProcessor';
import type { PermissionMode, GeminiMode, CodexMessagePayload } from '@/gemini/types';
import { GEMINI_MODEL_ENV, DEFAULT_GEMINI_MODEL, CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { 
  readGeminiLocalConfig, 
  determineGeminiModel, 
  saveGeminiModelToConfig,
  getInitialGeminiModel 
} from '@/gemini/utils/config';
import {
  parseOptionsFromText,
  hasIncompleteOptions,
  formatOptionsXml,
} from '@/gemini/utils/optionsParser';


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
  try {
    const vendorToken = await api.getVendorToken('gemini');
    if (vendorToken?.oauth?.access_token) {
      cloudToken = vendorToken.oauth.access_token;
      logger.debug('[Gemini] Using OAuth token from Happy cloud');
    }
  } catch (error) {
    logger.debug('[Gemini] Failed to fetch cloud token:', error);
  }

  //
  // Create session
  //

  const state: AgentState = {
    controlledByUser: false,
  };
  const metadata: Metadata = {
    path: process.cwd(),
    host: os.hostname(),
    version: packageJson.version,
    os: os.platform(),
    machineId: machineId,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: projectPath(),
    happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
    startedFromDaemon: opts.startedBy === 'daemon',
    hostPid: process.pid,
    startedBy: opts.startedBy || 'terminal',
    lifecycleState: 'running',
    lifecycleStateSince: Date.now(),
    flavor: 'gemini'
  };
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  const session = api.sessionSyncClient(response);

  // Report to daemon
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

  const messageQueue = new MessageQueue2<GeminiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides to apply per message
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;

  session.onUserMessage((message) => {
    // Resolve permission mode (validate) - same as Codex
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
      if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
        messagePermissionMode = message.meta.permissionMode as PermissionMode;
        currentPermissionMode = messagePermissionMode;
        // Update permission handler with new mode
        updatePermissionMode(messagePermissionMode);
        logger.debug(`[Gemini] Permission mode updated from user message to: ${currentPermissionMode}`);
      } else {
        logger.debug(`[Gemini] Invalid permission mode received: ${message.meta.permissionMode}`);
      }
    } else {
      logger.debug(`[Gemini] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
    }
    
    // Initialize permission mode if not set yet
    if (currentPermissionMode === undefined) {
      currentPermissionMode = 'default';
      updatePermissionMode('default');
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
        messageModel = message.meta.model;
        currentModel = messageModel;
        // Save model to config file so it persists across sessions
        updateDisplayedModel(messageModel, true); // Update UI and save to config
        // Show model change message in UI (this will trigger UI re-render)
        messageBuffer.addMessage(`Model changed to: ${messageModel}`, 'system');
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

  async function handleAbort() {
    logger.debug('[Gemini] Abort requested - stopping current task');
    
    // Send turn_aborted event (like Codex) when abort is requested
    session.sendCodexMessage({
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

  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  // Create permission handler for tool approval
  const permissionHandler = new GeminiPermissionHandler(session);
  
  // Create reasoning processor for handling thinking/reasoning chunks
  const reasoningProcessor = new GeminiReasoningProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendCodexMessage(message);
  });
  
  // Create diff processor for handling file edit events and diff tracking
  const diffProcessor = new GeminiDiffProcessor((message) => {
    // Callback to send messages directly from the processor
    session.sendCodexMessage(message);
  });
  
  // Update permission handler when permission mode changes
  const updatePermissionMode = (mode: PermissionMode) => {
    permissionHandler.setPermissionMode(mode);
  };

  // Accumulate Gemini response text for sending complete message to mobile
  let accumulatedResponse = '';
  let isResponseInProgress = false;
  let currentResponseMessageId: string | null = null; // Track the message ID for current response

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
        // Log status changes for debugging
        logger.debug(`[gemini] Status changed: ${msg.status}${msg.detail ? ` - ${msg.detail}` : ''}`);
        
        // Log error status with details
        if (msg.status === 'error') {
          logger.debug(`[gemini] ⚠️ Error status received: ${msg.detail || 'Unknown error'}`);
          
          // Send turn_aborted event (like Codex) when error occurs
          session.sendCodexMessage({
            type: 'turn_aborted',
            id: randomUUID(),
          });
        }
        
        if (msg.status === 'running') {
          thinking = true;
          session.keepAlive(thinking, 'remote');
          
          // Send task_started event (like Codex) when agent starts working
          session.sendCodexMessage({
            type: 'task_started',
            id: randomUUID(),
          });
          
          // Show thinking indicator in UI when agent starts working (like Codex)
          // This will be updated with actual thinking text when agent_thought_chunk events arrive
          // Always show thinking indicator when status becomes 'running' to give user feedback
          // Even if response is in progress, we want to show thinking for new operations
          messageBuffer.addMessage('Thinking...', 'system');
          
          // Don't reset accumulator here - tool calls can happen during a response
          // Accumulator will be reset when a new prompt is sent (in the main loop)
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          if (thinking) {
            // Clear thinking indicator when agent finishes
            thinking = false;
            // Remove thinking message from UI when agent finishes (like Codex)
            // The thinking messages will be replaced by actual response
          }
          thinking = false;
          session.keepAlive(thinking, 'remote');
          
          // Complete reasoning processor when status becomes idle (like Codex)
          // Only complete if there's actually reasoning content to complete
          // Skip if this is just the initial idle status after session creation
          const reasoningCompleted = reasoningProcessor.complete();
          
          // Send task_complete event (like Codex) when agent finishes
          // Only send if this is a real task completion (not initial idle)
          if (reasoningCompleted || isResponseInProgress) {
            session.sendCodexMessage({
              type: 'task_complete',
              id: randomUUID(),
            });
          }
          
          // Send accumulated response to mobile app when response is complete
          // Status 'idle' indicates task completion (similar to Codex's task_complete)
          if (isResponseInProgress && accumulatedResponse.trim()) {
            // Parse options from response text (for logging/debugging)
            // But keep options IN the text - mobile app's parseMarkdown will extract them
            const { text: messageText, options } = parseOptionsFromText(accumulatedResponse);
            
            // Mobile app parses options from text via parseMarkdown, so we need to keep them in the message
            // Re-add options XML block to the message text if options were found
            let finalMessageText = messageText;
            if (options.length > 0) {
              const optionsXml = formatOptionsXml(options);
              finalMessageText = messageText + optionsXml;
              logger.debug(`[gemini] Found ${options.length} options in response:`, options);
              logger.debug(`[gemini] Keeping options in message text for mobile app parsing`);
            } else if (hasIncompleteOptions(accumulatedResponse)) {
              // If we have incomplete options block, still send the message
              // The mobile app will handle incomplete blocks gracefully
              logger.debug(`[gemini] Warning: Incomplete options block detected but sending message anyway`);
            }
            
            const messageId = randomUUID();
            
            const messagePayload: CodexMessagePayload = {
              type: 'message',
              message: finalMessageText, // Include options XML in text for mobile app
              id: messageId,
              ...(options.length > 0 && { options }),
            };
            
            logger.debug(`[gemini] Sending complete message to mobile (length: ${finalMessageText.length}): ${finalMessageText.substring(0, 100)}...`);
            logger.debug(`[gemini] Full message payload:`, JSON.stringify(messagePayload, null, 2));
            // Use sendCodexMessage - mobile app parses options from message text via parseMarkdown
            session.sendCodexMessage(messagePayload);
            accumulatedResponse = '';
            isResponseInProgress = false;
          }
          // Note: sendReady() is called via emitReadyIfIdle() in the finally block after prompt completes
          // Don't call it here to avoid duplicates
        } else if (msg.status === 'error') {
          thinking = false;
          session.keepAlive(thinking, 'remote');
          accumulatedResponse = '';
          isResponseInProgress = false;
          currentResponseMessageId = null;
          
          // Show error in CLI UI
          const errorMessage = msg.detail || 'Unknown error';
          messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
          
          // Use sendCodexMessage for consistency with codex format
          session.sendCodexMessage({
            type: 'message',
            message: `Error: ${errorMessage}`,
            id: randomUUID(),
          });
        }
        break;

      case 'tool-call':
        // Show tool call in UI like Codex does
        const toolArgs = msg.args ? JSON.stringify(msg.args).substring(0, 100) : '';
        const isInvestigationTool = msg.toolName === 'codebase_investigator' || 
                                    (typeof msg.toolName === 'string' && msg.toolName.includes('investigator'));
        
        logger.debug(`[gemini] 🔧 Tool call received: ${msg.toolName} (${msg.callId})${isInvestigationTool ? ' [INVESTIGATION]' : ''}`);
        if (isInvestigationTool && msg.args && typeof msg.args === 'object' && 'objective' in msg.args) {
          logger.debug(`[gemini] 🔍 Investigation objective: ${String(msg.args.objective).substring(0, 150)}...`);
        }
        
        messageBuffer.addMessage(`Executing: ${msg.toolName}${toolArgs ? ` ${toolArgs}${toolArgs.length >= 100 ? '...' : ''}` : ''}`, 'tool');
        session.sendCodexMessage({
          type: 'tool-call',
          name: msg.toolName,
          callId: msg.callId,
          input: msg.args,
          id: randomUUID(),
        });
        break;

      case 'tool-result':
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
        
        session.sendCodexMessage({
          type: 'tool-call-result',
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
        
        session.sendCodexMessage({
          type: 'file-edit',
          description: msg.description,
          diff: msg.diff,
          path: msg.path,
          id: randomUUID(),
        });
        break;

      default:
        // Handle token-count and other potential message types
        if ((msg as any).type === 'token-count') {
          // Forward token count to mobile app (like Codex)
          // Note: Gemini ACP may not provide token_count events directly,
          // but we handle them if they come from the backend
          session.sendCodexMessage({
            type: 'token_count',
            ...(msg as any),
            id: randomUUID(),
          });
        }
        break;

      case 'terminal-output':
        messageBuffer.addMessage(msg.data, 'result');
        session.sendCodexMessage({
          type: 'terminal-output',
          data: msg.data,
          id: randomUUID(),
        });
        break;

      case 'permission-request':
        // Forward permission request to mobile app
        session.sendCodexMessage({
          type: 'permission-request',
          permissionId: msg.id,
          reason: msg.reason,
          payload: msg.payload,
          id: randomUUID(),
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
        
        session.sendCodexMessage({
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
        
        session.sendCodexMessage({
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
        
        session.sendCodexMessage({
          type: 'tool-call-result',
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
          session.sendCodexMessage({
            type: 'thinking',
            text: thinkingText,
            id: randomUUID(),
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

      // Handle mode change (like Codex) - restart session if permission mode or model changed
      if (wasSessionCreated && currentModeHash && message.hash !== currentModeHash) {
        logger.debug('[Gemini] Mode changed – restarting Gemini session');
        messageBuffer.addMessage('═'.repeat(40), 'status');
        messageBuffer.addMessage('Starting new Gemini session (mode changed)...', 'status');
        
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
        geminiBackend = createGeminiBackend({
          cwd: process.cwd(),
          mcpServers,
          permissionHandler,
          cloudToken,
          // Pass model from message - if undefined, will use local config/env/default
          // If explicitly null, will skip local config and use env/default
          model: modelToUse,
        });
        
        // Set up message handler again
        setupGeminiMessageHandler(geminiBackend);
        
        // Start new session
        // Determine actual model that will be used (from backend creation logic)
        // Replicate backend logic: message model > env var > local config > default
        const localConfigForModel = readGeminiLocalConfig();
        const actualModel = determineGeminiModel(modelToUse, localConfigForModel);
        logger.debug(`[gemini] Model change - modelToUse=${modelToUse}, actualModel=${actualModel}`);
        
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

      try {
        if (first || !wasSessionCreated) {
          // First message or session not created yet - create backend and start session
          if (!geminiBackend) {
            const modelToUse = message.mode?.model === undefined ? undefined : (message.mode.model || null);
            geminiBackend = createGeminiBackend({
              cwd: process.cwd(),
              mcpServers,
              permissionHandler,
              cloudToken,
              // Pass model from message - if undefined, will use local config/env/default
              // If explicitly null, will skip local config and use env/default
              model: modelToUse,
            });
            
            // Set up message handler
            setupGeminiMessageHandler(geminiBackend);
            
            // Determine actual model that will be used
            // Backend will determine model from: message model > env var > local config > default
            // We need to replicate this logic here to show correct model in UI
            const localConfigForModel = readGeminiLocalConfig();
            const actualModel = determineGeminiModel(modelToUse, localConfigForModel);
            
            const modelSource = modelToUse !== undefined 
              ? 'message' 
              : process.env[GEMINI_MODEL_ENV] 
                ? 'env-var' 
                : localConfigForModel.model 
                  ? 'local-config' 
                  : 'default';
            
            logger.debug(`[gemini] Backend created, model will be: ${actualModel} (from ${modelSource})`);
            logger.debug(`[gemini] Calling updateDisplayedModel with: ${actualModel}`);
            updateDisplayedModel(actualModel, false); // Don't save - this is backend initialization
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
        
        if (!geminiBackend || !acpSessionId) {
          throw new Error('Gemini backend or session not initialized');
        }
        
        // The prompt already includes system prompt and change_title instruction (added in onUserMessage handler)
        // This is done in the message queue, so message.message already contains everything
        const promptToSend = message.message;
        
        logger.debug(`[gemini] Sending prompt to Gemini (length: ${promptToSend.length}): ${promptToSend.substring(0, 100)}...`);
        logger.debug(`[gemini] Full prompt: ${promptToSend}`);
        await geminiBackend.sendPrompt(acpSessionId, promptToSend);
        logger.debug('[gemini] Prompt sent successfully');
        
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
            // Check for rate limit error (429) - multiple possible formats
            else if (errorCode === 429 || 
                     errorDetails.includes('429') || errorMessage.includes('429') || errorString.includes('429') ||
                     errorDetails.includes('rateLimitExceeded') || errorDetails.includes('RESOURCE_EXHAUSTED') ||
                     errorMessage.includes('Rate limit exceeded') || errorMessage.includes('Resource exhausted') ||
                     errorString.includes('rateLimitExceeded') || errorString.includes('RESOURCE_EXHAUSTED')) {
              errorMsg = 'Gemini API rate limit exceeded. Please wait a moment and try again. The API will retry automatically.';
            }
            // Check for quota exceeded error
            else if (errorDetails.includes('quota') || errorMessage.includes('quota') || errorString.includes('quota')) {
              errorMsg = 'Gemini API daily quota exceeded. Please wait until quota resets or use a paid API key.';
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
          // Use sendCodexMessage for consistency with codex format
          session.sendCodexMessage({
            type: 'message',
            message: errorMsg,
            id: randomUUID(),
          });
        }
      } finally {
        // Reset permission handler, reasoning processor, and diff processor after turn (like Codex)
        permissionHandler.reset();
        reasoningProcessor.abort(); // Use abort to properly finish any in-progress tool calls
        diffProcessor.reset(); // Reset diff processor on turn completion
        
        thinking = false;
        session.keepAlive(thinking, 'remote');
        
        // Use same logic as Codex - emit ready if idle (no pending operations, no queue)
        emitReadyIfIdle();
        
        logger.debug(`[gemini] Main loop: turn completed, continuing to next iteration (queue size: ${messageQueue.size()})`);
      }
    }

  } finally {
    // Clean up resources
    logger.debug('[gemini]: Final cleanup start');
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

