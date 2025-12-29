/**
 * AcpSdkBackend - Agent Client Protocol backend using official SDK
 * 
 * This module provides a backend implementation using the official
 * @agentclientprotocol/sdk for direct control over the ACP protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { 
  ClientSideConnection, 
  ndJsonStream,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type InitializeRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ContentBlock,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import type { 
  AgentBackend, 
  AgentMessage, 
  AgentMessageHandler, 
  SessionId,
  StartSessionResult,
  McpServerConfig,
} from '../AgentBackend';
import { logger } from '@/ui/logger';
import packageJson from '../../../package.json';
import {
  isInvestigationTool,
  determineToolName,
  getRealToolName,
  getToolCallTimeout,
} from './utils';
import { hasChangeTitleInstruction } from '@/gemini/utils/promptUtils';

/**
 * Extended RequestPermissionRequest with additional fields that may be present
 */
type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    id?: string;
    kind?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

/**
 * Extended SessionNotification with additional fields
 */
type ExtendedSessionNotification = SessionNotification & {
  update?: {
    sessionUpdate?: string;
    toolCallId?: string;
    status?: string;
    kind?: string | unknown;
    content?: {
      text?: string;
      error?: string | { message?: string };
      [key: string]: unknown;
    } | string | unknown;
    locations?: unknown[];
    messageChunk?: {
      textDelta?: string;
    };
    plan?: unknown;
    thinking?: unknown;
    [key: string]: unknown;
  };
}

/** Timeout for ACP initialization in milliseconds (2 minutes - Gemini CLI can be slow on first start) */
const ACP_INIT_TIMEOUT_MS = 120000;

/**
 * Permission handler interface for ACP backends
 */
export interface AcpPermissionHandler {
  /**
   * Handle a tool permission request
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @returns Promise resolving to permission result with decision
   */
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'denied' | 'abort' }>;
}

/**
 * Configuration for AcpSdkBackend
 */
export interface AcpSdkBackendOptions {
  /** Agent name for identification */
  agentName: string;
  
  /** Working directory for the agent */
  cwd: string;
  
  /** Command to spawn the ACP agent */
  command: string;
  
  /** Arguments for the agent command */
  args?: string[];
  
  /** Environment variables to pass to the agent */
  env?: Record<string, string>;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Convert Node.js streams to Web Streams for ACP SDK
 * 
 * NOTE: This function registers event handlers on stdout. If you also register
 * handlers directly on stdout (e.g., for logging), both will fire.
 */
function nodeToWebStreams(
  stdin: Writable, 
  stdout: Readable
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
  // Convert Node writable to Web WritableStream
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = stdin.write(chunk, (err) => {
          if (err) {
            logger.debug(`[AcpSdkBackend] Error writing to stdin:`, err);
            reject(err);
          }
        });
        if (ok) {
          resolve();
        } else {
          stdin.once('drain', resolve);
        }
      });
    },
    close() {
      return new Promise((resolve) => {
        stdin.end(resolve);
      });
    },
    abort(reason) {
      stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });

  // Convert Node readable to Web ReadableStream
  // Filter out non-JSON debug output from gemini CLI (experiments, flags, etc.)
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stdout.on('end', () => {
        controller.close();
      });
      stdout.on('error', (err) => {
        logger.debug(`[AcpSdkBackend] Stdout error:`, err);
        controller.error(err);
      });
    },
    cancel() {
      stdout.destroy();
    }
  });

  return { writable, readable };
}

/**
 * ACP backend using the official @agentclientprotocol/sdk
 */
export class AcpSdkBackend implements AgentBackend {
  private listeners: AgentMessageHandler[] = [];
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private disposed = false;
  /** Track active tool calls to prevent duplicate events */
  private activeToolCalls = new Set<string>();
  private toolCallTimeouts = new Map<string, NodeJS.Timeout>();
  /** Track tool call start times for performance monitoring */
  private toolCallStartTimes = new Map<string, number>();
  /** Pending permission requests that need response */
  private pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();
  
  /** Map from permission request ID to real tool call ID for tracking */
  private permissionToToolCallMap = new Map<string, string>();
  
  /** Map from real tool call ID to tool name for auto-approval */
  private toolCallIdToNameMap = new Map<string, string>();
  
  /** Track if we just sent a prompt with change_title instruction */
  private recentPromptHadChangeTitle = false;
  
  /** Track tool calls count since last prompt (to identify first tool call) */
  private toolCallCountSincePrompt = 0;
  /** Timeout for emitting 'idle' status after last message chunk */
  private idleTimeout: NodeJS.Timeout | null = null;

  constructor(private options: AcpSdkBackendOptions) {
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  } 

  offMessage(handler: AgentMessageHandler): void {
    const index = this.listeners.indexOf(handler);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(msg: AgentMessage): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (error) {
        logger.warn('[AcpSdkBackend] Error in message handler:', error);
      }
    }
  }

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const sessionId = randomUUID();
    this.emit({ type: 'status', status: 'starting' });

    try {
      logger.debug(`[AcpSdkBackend] Starting session: ${sessionId}`);
      // Spawn the ACP agent process
      const args = this.options.args || [];
      
      // On Windows, spawn via cmd.exe to handle .cmd files and PATH resolution
      // This ensures proper stdio piping without shell buffering
      if (process.platform === 'win32') {
        const fullCommand = [this.options.command, ...args].join(' ');
        this.process = spawn('cmd.exe', ['/c', fullCommand], {
          cwd: this.options.cwd,
          env: { ...process.env, ...this.options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        this.process = spawn(this.options.command, args, {
          cwd: this.options.cwd,
          env: { ...process.env, ...this.options.env },
          // Use 'pipe' for all stdio to capture output without printing to console
          // stdout and stderr will be handled by our event listeners
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      
      // Ensure stderr doesn't leak to console - redirect to logger only
      // This prevents gemini CLI debug output from appearing in user's console
      if (this.process.stderr) {
        // stderr is already handled by the event listener below
        // but we ensure it doesn't go to parent's stderr
      }

      if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
        throw new Error('Failed to create stdio pipes');
      }

      // Suppress stderr output - redirect to logger only (not console)
      // Gemini CLI may output debug info to stderr, but we don't want it in console
      // However, we need to detect API errors (like 429 rate limit) and notify the user
      this.process.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        // Only log to file, never to console
        if (text.trim()) {
          // Check if we have active investigation tools - log stderr more verbosely for them
          const hasActiveInvestigation = Array.from(this.activeToolCalls).some(id => 
            isInvestigationTool(id)
          );
          
          if (hasActiveInvestigation) {
            logger.debug(`[AcpSdkBackend] 🔍 Agent stderr (during investigation): ${text.trim()}`);
          } else {
            logger.debug(`[AcpSdkBackend] Agent stderr: ${text.trim()}`);
          }
          
          // Detect API errors in stderr (429 rate limit, 404 not found, etc.)
          // These errors come from gemini-cli when API calls fail
          // Note: gemini-cli handles retries internally, we don't need to track or show these
          if (text.includes('status 429') || text.includes('code":429') || 
              text.includes('rateLimitExceeded') || text.includes('RESOURCE_EXHAUSTED')) {
            // Rate limit error - log for debugging but don't show to user
            // Gemini CLI will handle retries internally
            logger.debug('[AcpSdkBackend] ⚠️ Detected rate limit error (429) in stderr - gemini-cli will handle retry');
          } else if (text.includes('status 404') || text.includes('code":404')) {
            // Not found error - emit error status
            logger.debug('[AcpSdkBackend] ⚠️ Detected 404 error in stderr');
            this.emit({
              type: 'status',
              status: 'error',
              detail: 'Model not found. Available models: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite'
            });
          } else if (hasActiveInvestigation && (
            text.includes('timeout') || text.includes('Timeout') || 
            text.includes('failed') || text.includes('Failed') ||
            text.includes('error') || text.includes('Error')
          )) {
            // Log any errors/timeouts during investigation tools for debugging
            logger.debug(`[AcpSdkBackend] 🔍 Investigation tool stderr error/timeout: ${text.trim()}`);
          }
          
        }
      });

      this.process.on('error', (err) => {
        // Log to file only, not console
        logger.debug(`[AcpSdkBackend] Process error:`, err);
        this.emit({ type: 'status', status: 'error', detail: err.message });
      });

      this.process.on('exit', (code, signal) => {
        if (!this.disposed && code !== 0 && code !== null) {
          logger.debug(`[AcpSdkBackend] Process exited with code ${code}, signal ${signal}`);
          this.emit({ type: 'status', status: 'stopped', detail: `Exit code: ${code}` });
        }
      });

      // Create Web Streams from Node streams
      const streams = nodeToWebStreams(
        this.process.stdin,
        this.process.stdout
      );
      const writable = streams.writable;
      const readable = streams.readable;

      // Filter out non-JSON data before it reaches ndJsonStream
      // Gemini CLI outputs debug info (experiments, flags, etc.) to stdout
      // which breaks ACP protocol parsing. We filter it silently.
      const filteredReadable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = readable.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = '';
          let filteredCount = 0;
          
          // Helper function to check if a string is valid JSON
          const isValidJSON = (str: string): boolean => {
            const trimmed = str.trim();
            if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
              return false;
            }
            try {
              JSON.parse(trimmed);
              return true;
            } catch {
              return false;
            }
          };
          
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Flush any remaining buffer
                if (buffer.trim()) {
                  if (isValidJSON(buffer)) {
                    controller.enqueue(encoder.encode(buffer));
                  } else {
                    filteredCount++;
                  }
                }
                if (filteredCount > 0) {
                  logger.debug(`[AcpSdkBackend] Filtered out ${filteredCount} non-JSON lines from gemini CLI stdout`);
                }
                controller.close();
                break;
              }
              
              // Decode and accumulate data
              buffer += decoder.decode(value, { stream: true });
              
              // Process line by line (ndJSON is line-delimited)
              const lines = buffer.split('\n');
              buffer = lines.pop() || ''; // Keep last incomplete line in buffer
              
              for (const line of lines) {
                const trimmed = line.trim();
                
                // Skip empty lines
                if (!trimmed) {
                  continue;
                }
                
                // Validate JSON before passing through
                if (isValidJSON(trimmed)) {
                  // Valid JSON line - pass it through
                  controller.enqueue(encoder.encode(line + '\n'));
                } else {
                  // Non-JSON or invalid JSON - silently skip it
                  filteredCount++;
                }
              }
            }
          } catch (error) {
            logger.debug(`[AcpSdkBackend] Error filtering stdout stream:`, error);
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        }
      });

      // Create ndJSON stream for ACP
      const stream = ndJsonStream(writable, filteredReadable);

      // Create Client implementation
      const client: Client = {
        sessionUpdate: async (params: SessionNotification) => {
          this.handleSessionUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          
          const permissionId = randomUUID();
          const extendedParams = params as ExtendedRequestPermissionRequest;
          const toolCall = extendedParams.toolCall;
          let toolName = toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool';
          const toolCallId = toolCall?.id || permissionId;
          
          // Extract input/arguments from various possible locations FIRST (before checking toolName)
          let input: Record<string, unknown> = {};
          if (toolCall) {
            input = toolCall.input || toolCall.arguments || toolCall.content || {};
          } else {
            // If no toolCall, try to extract from params directly
            input = extendedParams.input || extendedParams.arguments || extendedParams.content || {};
          }
          
          // If toolName is "other" or "Unknown tool", try to determine real tool name
          toolName = determineToolName(
            toolName,
            toolCallId,
            input,
            params,
            {
              recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
              toolCallCountSincePrompt: this.toolCallCountSincePrompt,
            }
          );
          
          if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
            logger.debug(`[AcpSdkBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
          }
          
          // Increment tool call counter for context tracking
          this.toolCallCountSincePrompt++;
          
          const options = extendedParams.options || [];
          
          // Log permission request for debugging (include full params to understand structure)
          logger.debug(`[AcpSdkBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, input=`, JSON.stringify(input));
          logger.debug(`[AcpSdkBackend] Permission request params structure:`, JSON.stringify({
            hasToolCall: !!toolCall,
            toolCallKind: toolCall?.kind,
            toolCallId: toolCall?.id,
            paramsKind: extendedParams.kind,
            paramsKeys: Object.keys(params),
          }, null, 2));
          
          // Emit permission request event for UI/mobile handling
          this.emit({
            type: 'permission-request',
            id: permissionId,
            reason: toolName,
            payload: {
              ...params,
              permissionId,
              toolCallId,
              toolName,
              input,
              options: options.map((opt) => ({
                id: opt.optionId,
                name: opt.name,
                kind: opt.kind,
              })),
            },
          });
          
          // Use permission handler if provided, otherwise auto-approve
          if (this.options.permissionHandler) {
            try {
              const result = await this.options.permissionHandler.handleToolCall(
                toolCallId,
                toolName,
                input
              );
              
              // Map permission decision to ACP response
              // ACP uses optionId from the request options
              let optionId = 'cancel'; // Default to cancel/deny
              
              if (result.decision === 'approved' || result.decision === 'approved_for_session') {
                // Find the appropriate optionId from the request options
                // Look for 'proceed_once' or 'proceed_always' in options
                const proceedOnceOption = options.find((opt: any) => 
                  opt.optionId === 'proceed_once' || opt.name?.toLowerCase().includes('once')
                );
                const proceedAlwaysOption = options.find((opt: any) => 
                  opt.optionId === 'proceed_always' || opt.name?.toLowerCase().includes('always')
                );
                
                if (result.decision === 'approved_for_session' && proceedAlwaysOption) {
                  optionId = proceedAlwaysOption.optionId || 'proceed_always';
                } else if (proceedOnceOption) {
                  optionId = proceedOnceOption.optionId || 'proceed_once';
                } else if (options.length > 0) {
                  // Fallback to first option if no specific match
                  optionId = options[0].optionId || 'proceed_once';
                }
              } else {
                // Denied or aborted - find cancel option
                const cancelOption = options.find((opt: any) => 
                  opt.optionId === 'cancel' || opt.name?.toLowerCase().includes('cancel')
                );
                if (cancelOption) {
                  optionId = cancelOption.optionId || 'cancel';
                }
              }
              
              return { outcome: { outcome: 'selected', optionId } };
            } catch (error) {
              // Log to file only, not console
              logger.debug('[AcpSdkBackend] Error in permission handler:', error);
              // Fallback to deny on error
              return { outcome: { outcome: 'selected', optionId: 'cancel' } };
            }
          }
          
          // Auto-approve with 'proceed_once' if no permission handler
          // optionId must match one from the request options (e.g., 'proceed_once', 'proceed_always', 'cancel')
          const proceedOnceOption = options.find((opt) => 
            opt.optionId === 'proceed_once' || (typeof opt.name === 'string' && opt.name.toLowerCase().includes('once'))
          );
          const defaultOptionId = proceedOnceOption?.optionId || (options.length > 0 && options[0].optionId ? options[0].optionId : 'proceed_once');
          return { outcome: { outcome: 'selected', optionId: defaultOptionId } };
        },
      };

      // Create ClientSideConnection
      this.connection = new ClientSideConnection(
        (agent: Agent) => client,
        stream
      );

      // Initialize the connection with timeout
      const initRequest: InitializeRequest = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile: false,
            writeTextFile: false,
          },
        },
        clientInfo: {
          name: 'happy-cli',
          version: packageJson.version,
        },
      };

      logger.debug(`[AcpSdkBackend] Initializing connection...`);
      let initTimeout: NodeJS.Timeout | null = null;
      const initResponse = await Promise.race([
        this.connection.initialize(initRequest).then((result) => {
          // Clear timeout if initialization succeeds
          if (initTimeout) {
            clearTimeout(initTimeout);
            initTimeout = null;
          }
          return result;
        }),
        new Promise<never>((_, reject) => {
          initTimeout = setTimeout(() => {
            logger.debug(`[AcpSdkBackend] Initialize timeout after ${ACP_INIT_TIMEOUT_MS}ms`);
            reject(new Error(`Initialize timeout after ${ACP_INIT_TIMEOUT_MS}ms - Gemini CLI did not respond`));
          }, ACP_INIT_TIMEOUT_MS);
        }),
      ]);
      logger.debug(`[AcpSdkBackend] Initialize completed`);

      // Create a new session
      const mcpServers = this.options.mcpServers 
        ? Object.entries(this.options.mcpServers).map(([name, config]) => ({
            name,
            command: config.command,
            args: config.args || [],
            env: config.env 
              ? Object.entries(config.env).map(([envName, envValue]) => ({ name: envName, value: envValue }))
              : [],
          }))
        : [];

      const newSessionRequest: NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: mcpServers as unknown as NewSessionRequest['mcpServers'],
      };

      logger.debug(`[AcpSdkBackend] Creating new session...`);
      let newSessionTimeout: NodeJS.Timeout | null = null;
      const sessionResponse = await Promise.race([
        this.connection.newSession(newSessionRequest).then((result) => {
          // Clear timeout if session creation succeeds
          if (newSessionTimeout) {
            clearTimeout(newSessionTimeout);
            newSessionTimeout = null;
          }
          return result;
        }),
        new Promise<never>((_, reject) => {
          newSessionTimeout = setTimeout(() => {
            logger.debug(`[AcpSdkBackend] NewSession timeout after ${ACP_INIT_TIMEOUT_MS}ms`);
            reject(new Error('New session timeout'));
          }, ACP_INIT_TIMEOUT_MS);
        }),
      ]);
      this.acpSessionId = sessionResponse.sessionId;
      logger.debug(`[AcpSdkBackend] Session created: ${this.acpSessionId}`);

      this.emit({ type: 'status', status: 'idle' });

      // Send initial prompt if provided
      if (initialPrompt) {
        this.sendPrompt(sessionId, initialPrompt).catch((error) => {
          // Log to file only, not console
          logger.debug('[AcpSdkBackend] Error sending initial prompt:', error);
          this.emit({ type: 'status', status: 'error', detail: String(error) });
        });
      }

      return { sessionId };

    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpSdkBackend] Error starting session:', error);
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  private handleSessionUpdate(params: SessionNotification): void {
    // SessionNotification structure: { sessionId, update: { sessionUpdate, content, ... } }
    const notification = params as ExtendedSessionNotification;
    const update = notification.update;
    
    if (!update) {
      logger.debug('[AcpSdkBackend] Received session update without update field:', params);
      return;
    }

    const sessionUpdateType = update.sessionUpdate;
    
    // Log session updates for debugging (but not every chunk to avoid log spam)
    if (sessionUpdateType !== 'agent_message_chunk') {
      logger.debug(`[AcpSdkBackend] Received session update: ${sessionUpdateType}`, JSON.stringify({
        sessionUpdate: sessionUpdateType,
        toolCallId: update.toolCallId,
        status: update.status,
        kind: update.kind,
        hasContent: !!update.content,
        hasLocations: !!update.locations,
      }, null, 2));
    }

    // Handle agent message chunks (text output from Gemini)
    if (sessionUpdateType === 'agent_message_chunk') {
      
      const content = update.content;
      if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
        const text = content.text;
        
        // Filter out "thinking" messages (start with **...**)
        // These are internal reasoning, not user-facing output
        const isThinking = /^\*\*[^*]+\*\*\n/.test(text);
        
        if (isThinking) {
          // Emit as thinking event instead of model output
          this.emit({
            type: 'event',
            name: 'thinking',
            payload: { text },
          });
        } else {
          logger.debug(`[AcpSdkBackend] Received message chunk (length: ${text.length}): ${text.substring(0, 50)}...`);
          this.emit({
            type: 'model-output',
            textDelta: text,
          });
          
          // Reset idle timeout - more chunks are coming
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          
          // Set timeout to emit 'idle' after a short delay when no more chunks arrive
          // This delay ensures all chunks (especially options blocks) are received before marking as idle
          this.idleTimeout = setTimeout(() => {
            // Only emit idle if no active tool calls
            if (this.activeToolCalls.size === 0) {
              logger.debug('[AcpSdkBackend] No more chunks received, emitting idle status');
              this.emit({ type: 'status', status: 'idle' });
            } else {
              logger.debug(`[AcpSdkBackend] Delaying idle status - ${this.activeToolCalls.size} active tool calls`);
            }
            this.idleTimeout = null;
          }, 500); // 500ms delay to batch chunks (reduced from 500ms, but still enough for options)
        }
      }
    }

    // Handle tool call updates
    if (sessionUpdateType === 'tool_call_update') {
      const status = update.status;
      const toolCallId = update.toolCallId;
      
      if (!toolCallId) {
        logger.debug('[AcpSdkBackend] Tool call update without toolCallId:', update);
        return;
      }
      
        if (status === 'in_progress' || status === 'pending') {
        // Only emit tool-call if we haven't seen this toolCallId before
        if (!this.activeToolCalls.has(toolCallId)) {
          const startTime = Date.now();
          const toolKind = update.kind || 'unknown';
          const isInvestigation = isInvestigationTool(toolCallId, toolKind);
          
          // Determine real tool name from toolCallId (e.g., "change_title-1765385846663" -> "change_title")
          const realToolName = getRealToolName(toolCallId, toolKind);
          
          // Store mapping for permission requests
          this.toolCallIdToNameMap.set(toolCallId, realToolName);
          
          this.activeToolCalls.add(toolCallId);
          this.toolCallStartTimes.set(toolCallId, startTime);
          logger.debug(`[AcpSdkBackend] ⏱️ Set startTime for ${toolCallId} at ${new Date(startTime).toISOString()} (from tool_call_update)`);
          
          // Increment tool call counter for context tracking
          this.toolCallCountSincePrompt++;
          
          logger.debug(`[AcpSdkBackend] 🔧 Tool call START: ${toolCallId} (${toolKind} -> ${realToolName})${isInvestigation ? ' [INVESTIGATION TOOL]' : ''}`);
          if (isInvestigation) {
            logger.debug(`[AcpSdkBackend] 🔍 Investigation tool detected (by toolCallId) - extended timeout (10min) will be used`);
          }
          
          // Set timeout for tool call completion (especially important for investigation tools)
          // This ensures timeout is set even if tool_call event doesn't arrive
          const timeoutMs = getToolCallTimeout(toolCallId, toolKind);
          
          // Only set timeout if not already set (from tool_call event)
          if (!this.toolCallTimeouts.has(toolCallId)) {
            const timeout = setTimeout(() => {
              const startTime = this.toolCallStartTimes.get(toolCallId);
              const duration = startTime ? Date.now() - startTime : null;
              const durationStr = duration ? `${(duration / 1000).toFixed(2)}s` : 'unknown';
              
              logger.debug(`[AcpSdkBackend] ⏱️ Tool call TIMEOUT (from tool_call_update): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${durationStr}, removing from active set`);
              this.activeToolCalls.delete(toolCallId);
              this.toolCallStartTimes.delete(toolCallId);
              this.toolCallTimeouts.delete(toolCallId);
              
              // Check if we should emit idle status
              if (this.activeToolCalls.size === 0) {
                logger.debug('[AcpSdkBackend] No more active tool calls after timeout, emitting idle status');
                this.emit({ type: 'status', status: 'idle' });
              }
            }, timeoutMs);
            
            this.toolCallTimeouts.set(toolCallId, timeout);
            logger.debug(`[AcpSdkBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s${isInvestigation ? ' (investigation tool)' : ''}`);
          } else {
            logger.debug(`[AcpSdkBackend] Timeout already set for ${toolCallId}, skipping`);
          }
          
          // Clear idle timeout - tool call is starting, agent is working
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          
          // Emit running status when tool call starts
          this.emit({ type: 'status', status: 'running' });
          
          // Parse args from content (can be array or object)
          let args: Record<string, unknown> = {};
          if (Array.isArray(update.content)) {
            // Convert array content to object if needed
            args = { items: update.content };
          } else if (update.content && typeof update.content === 'object' && update.content !== null) {
            args = update.content as Record<string, unknown>;
          }
          
          // Log tool call details for investigation tools
          if (isInvestigation && args.objective) {
            logger.debug(`[AcpSdkBackend] 🔍 Investigation tool objective: ${String(args.objective).substring(0, 100)}...`);
          }
          
          this.emit({
            type: 'tool-call',
            toolName: typeof toolKind === 'string' ? toolKind : 'unknown',
            args,
            callId: toolCallId,
          });
        } else {
          // Tool call already tracked - might be an update
          logger.debug(`[AcpSdkBackend] Tool call ${toolCallId} already tracked, status: ${status}`);
        }
      } else if (status === 'completed') {
        // Tool call finished - remove from active set and clear timeout
        const startTime = this.toolCallStartTimes.get(toolCallId);
        const duration = startTime ? Date.now() - startTime : null;
        const toolKind = update.kind || 'unknown';
        
        this.activeToolCalls.delete(toolCallId);
        this.toolCallStartTimes.delete(toolCallId);
        
        const timeout = this.toolCallTimeouts.get(toolCallId);
        if (timeout) {
          clearTimeout(timeout);
          this.toolCallTimeouts.delete(toolCallId);
        }
        
        const durationStr = duration ? `${(duration / 1000).toFixed(2)}s` : 'unknown';
        logger.debug(`[AcpSdkBackend] ✅ Tool call COMPLETED: ${toolCallId} (${toolKind}) - Duration: ${durationStr}. Active tool calls: ${this.activeToolCalls.size}`);
        
        this.emit({
          type: 'tool-result',
          toolName: typeof toolKind === 'string' ? toolKind : 'unknown',
          result: update.content,
          callId: toolCallId,
        });
        
        // If no more active tool calls, emit 'idle' immediately (like Codex's task_complete)
        // No timeout needed - when all tool calls complete, task is done
        if (this.activeToolCalls.size === 0) {
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          logger.debug('[AcpSdkBackend] All tool calls completed, emitting idle status');
          this.emit({ type: 'status', status: 'idle' });
        }
      } else if (status === 'failed' || status === 'cancelled') {
        // Tool call failed or was cancelled - remove from active set and clear timeout
        // IMPORTANT: Save values BEFORE deleting them for logging
        const startTime = this.toolCallStartTimes.get(toolCallId);
        const duration = startTime ? Date.now() - startTime : null;
        const toolKind = update.kind || 'unknown';
        const isInvestigation = isInvestigationTool(toolCallId, toolKind);
        const hadTimeout = this.toolCallTimeouts.has(toolCallId);
        
        // Log detailed timing information for investigation tools BEFORE cleanup
        if (isInvestigation) {
          const durationStr = duration ? `${(duration / 1000).toFixed(2)}s` : 'unknown';
          const durationMinutes = duration ? (duration / 1000 / 60).toFixed(2) : 'unknown';
          logger.debug(`[AcpSdkBackend] 🔍 Investigation tool ${status.toUpperCase()} after ${durationMinutes} minutes (${durationStr})`);
          
          // Check if this matches a 3-minute timeout pattern
          if (duration) {
            const threeMinutes = 3 * 60 * 1000;
            const tolerance = 5000; // 5 second tolerance
            if (Math.abs(duration - threeMinutes) < tolerance) {
              logger.debug(`[AcpSdkBackend] 🔍 ⚠️ Investigation tool failed at ~3 minutes - likely Gemini CLI timeout, not our timeout`);
            }
          }
          
          logger.debug(`[AcpSdkBackend] 🔍 Investigation tool FAILED - full update.content:`, JSON.stringify(update.content, null, 2));
          logger.debug(`[AcpSdkBackend] 🔍 Investigation tool timeout status BEFORE cleanup: ${hadTimeout ? 'timeout was set' : 'no timeout was set'}`);
          logger.debug(`[AcpSdkBackend] 🔍 Investigation tool startTime status BEFORE cleanup: ${startTime ? `set at ${new Date(startTime).toISOString()}` : 'not set'}`);
        }
        
        // Now cleanup - remove from active set and clear timeout
        this.activeToolCalls.delete(toolCallId);
        this.toolCallStartTimes.delete(toolCallId);
        
        const timeout = this.toolCallTimeouts.get(toolCallId);
        if (timeout) {
          clearTimeout(timeout);
          this.toolCallTimeouts.delete(toolCallId);
          logger.debug(`[AcpSdkBackend] Cleared timeout for ${toolCallId} (tool call ${status})`);
        } else {
          logger.debug(`[AcpSdkBackend] No timeout found for ${toolCallId} (tool call ${status}) - timeout may not have been set`);
        }
        
        const durationStr = duration ? `${(duration / 1000).toFixed(2)}s` : 'unknown';
        logger.debug(`[AcpSdkBackend] ❌ Tool call ${status.toUpperCase()}: ${toolCallId} (${toolKind}) - Duration: ${durationStr}. Active tool calls: ${this.activeToolCalls.size}`);
        
        // Extract error information from update.content if available
        let errorDetail: string | undefined;
        
        if (update.content) {
          if (typeof update.content === 'string') {
            errorDetail = update.content;
          } else if (typeof update.content === 'object' && update.content !== null && !Array.isArray(update.content)) {
            const content = update.content as unknown as Record<string, unknown>;
            if (content.error) {
              const error = content.error;
              errorDetail = typeof error === 'string' 
                ? error 
                : (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string')
                  ? error.message
                  : JSON.stringify(error);
            } else if (typeof content.message === 'string') {
              errorDetail = content.message;
            } else {
              // Try to extract any error-like fields
              const status = typeof content.status === 'string' ? content.status : undefined;
              const reason = typeof content.reason === 'string' ? content.reason : undefined;
              errorDetail = status || reason || JSON.stringify(content).substring(0, 500);
            }
          }
        }
        
        if (errorDetail) {
          logger.debug(`[AcpSdkBackend] ❌ Tool call error details: ${errorDetail.substring(0, 500)}`);
        } else {
          logger.debug(`[AcpSdkBackend] ❌ Tool call ${status} but no error details in update.content`);
        }
        
        // Emit tool-result with error information so user can see what went wrong
        this.emit({
          type: 'tool-result',
          toolName: typeof toolKind === 'string' ? toolKind : 'unknown',
          result: errorDetail 
            ? { error: errorDetail, status: status }
            : { error: `Tool call ${status}`, status: status },
          callId: toolCallId,
        });
        
        // If no more active tool calls, emit 'idle' immediately (like Codex's task_complete)
        if (this.activeToolCalls.size === 0) {
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          logger.debug('[AcpSdkBackend] All tool calls completed/failed, emitting idle status');
          this.emit({ type: 'status', status: 'idle' });
        }
      }
    }

    // Legacy format support (in case some agents use old format)
    if (update.messageChunk) {
      const chunk = update.messageChunk;
      if (chunk.textDelta) {
        this.emit({
          type: 'model-output',
          textDelta: chunk.textDelta,
        });
      }
    }

    // Handle plan updates
    if (update.plan) {
      this.emit({
        type: 'event',
        name: 'plan',
        payload: update.plan,
      });
    }

    // Handle agent_thought_chunk (Gemini's thinking/reasoning chunks)
    if (sessionUpdateType === 'agent_thought_chunk') {
      
      const content = update.content;
      if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
        const text = content.text;
        // Log thinking chunks for investigation tools (they can be long)
        const hasActiveInvestigation = Array.from(this.activeToolCalls).some(() => {
          // We can't directly check tool kind here, but we log for correlation
          return true; // Log all thinking chunks when tool calls are active
        });
        
        if (hasActiveInvestigation && this.activeToolCalls.size > 0) {
          const activeToolCallsList = Array.from(this.activeToolCalls);
          logger.debug(`[AcpSdkBackend] 💭 Thinking chunk received (${text.length} chars) during active tool calls: ${activeToolCallsList.join(', ')}`);
        }
        
        // Emit as thinking event - don't show as regular message
        this.emit({
          type: 'event',
          name: 'thinking',
          payload: { text },
        });
      }
    }

    // Handle tool_call (direct tool call, not just tool_call_update)
    if (sessionUpdateType === 'tool_call') {
      const toolCallId = update.toolCallId;
      const status = update.status;
      
      logger.debug(`[AcpSdkBackend] Received tool_call: toolCallId=${toolCallId}, status=${status}, kind=${update.kind}`);
      
      // tool_call can come without explicit status, assume 'in_progress' if status is missing
      const isInProgress = !status || status === 'in_progress' || status === 'pending';
      
      if (toolCallId && isInProgress) {
        
        // Only emit tool-call if we haven't seen this toolCallId before
        if (!this.activeToolCalls.has(toolCallId)) {
          const startTime = Date.now();
          this.activeToolCalls.add(toolCallId);
          this.toolCallStartTimes.set(toolCallId, startTime);
          logger.debug(`[AcpSdkBackend] Added tool call ${toolCallId} to active set. Total active: ${this.activeToolCalls.size}`);
          logger.debug(`[AcpSdkBackend] ⏱️ Set startTime for ${toolCallId} at ${new Date(startTime).toISOString()}`);
          
          // Clear idle timeout - tool call is starting, agent is working
          if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
          }
          
          // Set timeout for tool call completion (especially for "think" tools that may not send completion updates)
          // Think tools typically complete quickly, but we set a longer timeout for other tools
          // codebase_investigator and similar investigation tools can take 5+ minutes, so we use a much longer timeout
          // NOTE: update.kind may be "think" even for codebase_investigator, so we check toolCallId instead
          const isInvestigation = isInvestigationTool(toolCallId, update.kind);
          
          if (isInvestigation) {
            logger.debug(`[AcpSdkBackend] 🔍 Investigation tool detected (toolCallId: ${toolCallId}, kind: ${update.kind}) - using extended timeout (10min)`);
          }
          
          const timeoutMs = getToolCallTimeout(toolCallId, update.kind);
          
          // Only set timeout if not already set (from tool_call_update)
          if (!this.toolCallTimeouts.has(toolCallId)) {
            const timeout = setTimeout(() => {
              const startTime = this.toolCallStartTimes.get(toolCallId);
              const duration = startTime ? Date.now() - startTime : null;
              const durationStr = duration ? `${(duration / 1000).toFixed(2)}s` : 'unknown';
              
              logger.debug(`[AcpSdkBackend] ⏱️ Tool call TIMEOUT (from tool_call): ${toolCallId} (${update.kind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${durationStr}, removing from active set`);
              this.activeToolCalls.delete(toolCallId);
              this.toolCallStartTimes.delete(toolCallId);
              this.toolCallTimeouts.delete(toolCallId);
              
              // Check if we should emit idle status
              if (this.activeToolCalls.size === 0) {
                logger.debug('[AcpSdkBackend] No more active tool calls after timeout, emitting idle status');
                this.emit({ type: 'status', status: 'idle' });
              }
            }, timeoutMs);
            
            this.toolCallTimeouts.set(toolCallId, timeout);
            logger.debug(`[AcpSdkBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s${isInvestigation ? ' (investigation tool)' : ''}`);
          } else {
            logger.debug(`[AcpSdkBackend] Timeout already set for ${toolCallId}, skipping`);
          }
          
          // Emit running status when tool call starts
          this.emit({ type: 'status', status: 'running' });
          
          // Parse args from content (can be array or object)
          let args: Record<string, unknown> = {};
          if (Array.isArray(update.content)) {
            args = { items: update.content };
          } else if (update.content && typeof update.content === 'object') {
            args = update.content;
          }
          
          // Extract locations if present (for file operations)
          if (update.locations && Array.isArray(update.locations)) {
            args.locations = update.locations;
          }
          
          logger.debug(`[AcpSdkBackend] Emitting tool-call event: toolName=${update.kind}, toolCallId=${toolCallId}, args=`, JSON.stringify(args));
          
          this.emit({
            type: 'tool-call',
            toolName: update.kind || 'unknown',
            args,
            callId: toolCallId,
          });
        } else {
          logger.debug(`[AcpSdkBackend] Tool call ${toolCallId} already in active set, skipping`);
        }
      } else {
        logger.debug(`[AcpSdkBackend] Tool call ${toolCallId} not in progress (status: ${status}), skipping`);
      }
    }

    // Handle thinking/reasoning (explicit thinking field)
    if (update.thinking) {
      
      this.emit({
        type: 'event',
        name: 'thinking',
        payload: update.thinking,
      });
    }
    
    // Log unhandled session update types for debugging
    if (sessionUpdateType && 
        sessionUpdateType !== 'agent_message_chunk' && 
        sessionUpdateType !== 'tool_call_update' &&
        sessionUpdateType !== 'agent_thought_chunk' &&
        sessionUpdateType !== 'tool_call' &&
        !update.messageChunk &&
        !update.plan &&
        !update.thinking) {
      logger.debug(`[AcpSdkBackend] Unhandled session update type: ${sessionUpdateType}`, JSON.stringify(update, null, 2));
    }
  }

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    // Check if prompt contains change_title instruction
    const promptHasChangeTitle = hasChangeTitleInstruction(prompt);
    
    // Reset tool call counter and set flag
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;
    
    if (promptHasChangeTitle) {
      logger.debug('[AcpSdkBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern');
    }
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    this.emit({ type: 'status', status: 'running' });

    try {
      logger.debug(`[AcpSdkBackend] Sending prompt (length: ${prompt.length}): ${prompt.substring(0, 100)}...`);
      logger.debug(`[AcpSdkBackend] Full prompt: ${prompt}`);
      
      const contentBlock: ContentBlock = {
        type: 'text',
        text: prompt,
      };

      const promptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: [contentBlock],
      };

      logger.debug(`[AcpSdkBackend] Prompt request:`, JSON.stringify(promptRequest, null, 2));
      await this.connection.prompt(promptRequest);
      logger.debug('[AcpSdkBackend] Prompt request sent to ACP connection');
      
      // Don't emit 'idle' here - it will be emitted after all message chunks are received
      // The idle timeout in handleSessionUpdate will emit 'idle' after the last chunk

    } catch (error) {
      logger.debug('[AcpSdkBackend] Error sending prompt:', error);
      
      // Extract error details for better error handling
      let errorDetail: string;
      if (error instanceof Error) {
        errorDetail = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errObj = error as Record<string, unknown>;
        // Try to extract structured error information
        const fallbackMessage = (typeof errObj.message === 'string' ? errObj.message : undefined) || String(error);
        if (errObj.code !== undefined) {
          errorDetail = JSON.stringify({ code: errObj.code, message: fallbackMessage });
        } else if (typeof errObj.message === 'string') {
          errorDetail = errObj.message;
        } else {
          errorDetail = String(error);
        }
      } else {
        errorDetail = String(error);
      }
      
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: errorDetail
      });
      throw error;
    }
  }

  async cancel(sessionId: SessionId): Promise<void> {
    if (!this.connection || !this.acpSessionId) {
      return;
    }

    try {
      await this.connection.cancel({ sessionId: this.acpSessionId });
      this.emit({ type: 'status', status: 'stopped', detail: 'Cancelled by user' });
    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpSdkBackend] Error cancelling:', error);
    }
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    logger.debug(`[AcpSdkBackend] Permission response: ${requestId} = ${approved}`);
    this.emit({ type: 'permission-response', id: requestId, approved });
    // TODO: Implement actual permission response when needed
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    
    logger.debug('[AcpSdkBackend] Disposing backend');
    this.disposed = true;

    // Try graceful shutdown first
    if (this.connection && this.acpSessionId) {
      try {
        // Send cancel to stop any ongoing work
        await Promise.race([
          this.connection.cancel({ sessionId: this.acpSessionId }),
          new Promise((resolve) => setTimeout(resolve, 2000)), // 2s timeout for graceful shutdown
        ]);
      } catch (error) {
        logger.debug('[AcpSdkBackend] Error during graceful shutdown:', error);
      }
    }

    // Kill the process
    if (this.process) {
      // Try SIGTERM first, then SIGKILL after timeout
      this.process.kill('SIGTERM');
      
      // Give process 1 second to terminate gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.debug('[AcpSdkBackend] Force killing process');
            this.process.kill('SIGKILL');
          }
          resolve();
        }, 1000);
        
        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      
      this.process = null;
    }

    // Clear timeouts
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }

    // Clear state
    this.listeners = [];
    this.connection = null;
    this.acpSessionId = null;
    this.activeToolCalls.clear();
    // Clear all tool call timeouts
    for (const timeout of this.toolCallTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.toolCallTimeouts.clear();
    this.toolCallStartTimes.clear();
    this.pendingPermissions.clear();
  }
}
