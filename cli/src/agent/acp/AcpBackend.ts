/**
 * AcpBackend - Agent Client Protocol backend using official SDK
 *
 * This module provides a universal backend implementation using the official
 * @agentclientprotocol/sdk. Agent-specific behavior (timeouts, filtering,
 * error handling) is delegated to TransportHandler implementations.
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
} from '../core';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import packageJson from '../../../package.json';

/**
 * Retry configuration for ACP operations
 */
const RETRY_CONFIG = {
  /** Maximum number of retry attempts for init/newSession */
  maxAttempts: 3,
  /** Base delay between retries in ms */
  baseDelayMs: 1000,
  /** Maximum delay between retries in ms */
  maxDelayMs: 5000,
} as const;
import {
  type TransportHandler,
  type StderrContext,
  type ToolNameContext,
  DefaultTransport,
} from '../transport';
import {
  type SessionUpdate,
  type HandlerContext,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  handleAgentMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
} from './sessionUpdateHandlers';

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
 * Configuration for AcpBackend
 */
export interface AcpBackendOptions {
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

  /** Transport handler for agent-specific behavior (timeouts, filtering, etc.) */
  transportHandler?: TransportHandler;

  /** Optional callback to check if prompt has change_title instruction */
  hasChangeTitleInstruction?: (prompt: string) => boolean;
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
            logger.debug(`[AcpBackend] Error writing to stdin:`, err);
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
        logger.debug(`[AcpBackend] Stdout error:`, err);
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
 * Helper to run an async operation with retry logic
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    operationName: string;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  }
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < options.maxAttempts) {
        // Calculate delay with exponential backoff
        const delayMs = Math.min(
          options.baseDelayMs * Math.pow(2, attempt - 1),
          options.maxDelayMs
        );

        logger.debug(`[AcpBackend] ${options.operationName} failed (attempt ${attempt}/${options.maxAttempts}): ${lastError.message}. Retrying in ${delayMs}ms...`);
        options.onRetry?.(attempt, lastError);

        await delay(delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * ACP backend using the official @agentclientprotocol/sdk
 */
export class AcpBackend implements AgentBackend {
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

  /** Transport handler for agent-specific behavior */
  private readonly transport: TransportHandler;

  constructor(private options: AcpBackendOptions) {
    this.transport = options.transportHandler ?? new DefaultTransport(options.agentName);
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
        logger.warn('[AcpBackend] Error in message handler:', error);
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
      logger.debug(`[AcpBackend] Starting session: ${sessionId}`);
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

      // Handle stderr output via transport handler
      this.process.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        if (!text.trim()) return;

        // Build context for transport handler
        const hasActiveInvestigation = this.transport.isInvestigationTool
          ? Array.from(this.activeToolCalls).some(id => this.transport.isInvestigationTool!(id))
          : false;

        const context: StderrContext = {
          activeToolCalls: this.activeToolCalls,
          hasActiveInvestigation,
        };

        // Log to file (not console)
        if (hasActiveInvestigation) {
          logger.debug(`[AcpBackend] 🔍 Agent stderr (during investigation): ${text.trim()}`);
        } else {
          logger.debug(`[AcpBackend] Agent stderr: ${text.trim()}`);
        }

        // Let transport handler process stderr and optionally emit messages
        if (this.transport.handleStderr) {
          const result = this.transport.handleStderr(text, context);
          if (result.message) {
            this.emit(result.message);
          }
        }
      });

      this.process.on('error', (err) => {
        // Log to file only, not console
        logger.debug(`[AcpBackend] Process error:`, err);
        this.emit({ type: 'status', status: 'error', detail: err.message });
      });

      this.process.on('exit', (code, signal) => {
        if (!this.disposed && code !== 0 && code !== null) {
          logger.debug(`[AcpBackend] Process exited with code ${code}, signal ${signal}`);
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

      // Filter stdout via transport handler before ACP parsing
      // Some agents output debug info that breaks JSON-RPC parsing
      const transport = this.transport;
      const filteredReadable = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = readable.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = '';
          let filteredCount = 0;

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Flush any remaining buffer
                if (buffer.trim()) {
                  const filtered = transport.filterStdoutLine?.(buffer);
                  if (filtered === undefined) {
                    controller.enqueue(encoder.encode(buffer));
                  } else if (filtered !== null) {
                    controller.enqueue(encoder.encode(filtered));
                  } else {
                    filteredCount++;
                  }
                }
                if (filteredCount > 0) {
                  logger.debug(`[AcpBackend] Filtered out ${filteredCount} non-JSON lines from ${transport.agentName} stdout`);
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
                if (!line.trim()) continue;

                // Use transport handler to filter lines
                // Note: filterStdoutLine returns null to filter out, string to keep
                // If method not implemented (undefined), pass through original line
                const filtered = transport.filterStdoutLine?.(line);
                if (filtered === undefined) {
                  // Method not implemented, pass through
                  controller.enqueue(encoder.encode(line + '\n'));
                } else if (filtered !== null) {
                  // Method returned transformed line
                  controller.enqueue(encoder.encode(filtered + '\n'));
                } else {
                  // Method returned null, filter out
                  filteredCount++;
                }
              }
            }
          } catch (error) {
            logger.debug(`[AcpBackend] Error filtering stdout stream:`, error);
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
          
          const extendedParams = params as ExtendedRequestPermissionRequest;
          const toolCall = extendedParams.toolCall;
          let toolName = toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool';
          // Use toolCallId as the single source of truth for permission ID
          // This ensures mobile app sends back the same ID that we use to store pending requests
          const toolCallId = toolCall?.id || randomUUID();
          const permissionId = toolCallId; // Use same ID for consistency!
          
          // Extract input/arguments from various possible locations FIRST (before checking toolName)
          let input: Record<string, unknown> = {};
          if (toolCall) {
            input = toolCall.input || toolCall.arguments || toolCall.content || {};
          } else {
            // If no toolCall, try to extract from params directly
            input = extendedParams.input || extendedParams.arguments || extendedParams.content || {};
          }
          
          // If toolName is "other" or "Unknown tool", try to determine real tool name
          const context: ToolNameContext = {
            recentPromptHadChangeTitle: this.recentPromptHadChangeTitle,
            toolCallCountSincePrompt: this.toolCallCountSincePrompt,
          };
          toolName = this.transport.determineToolName?.(toolName, toolCallId, input, context) ?? toolName;
          
          if (toolName !== (toolCall?.kind || toolCall?.toolName || extendedParams.kind || 'Unknown tool')) {
            logger.debug(`[AcpBackend] Detected tool name: ${toolName} from toolCallId: ${toolCallId}`);
          }
          
          // Increment tool call counter for context tracking
          this.toolCallCountSincePrompt++;
          
          const options = extendedParams.options || [];
          
          // Log permission request for debugging (include full params to understand structure)
          logger.debug(`[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, input=`, JSON.stringify(input));
          logger.debug(`[AcpBackend] Permission request params structure:`, JSON.stringify({
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
                
                // Emit tool-result with permissionId so UI can close the timer
                // This is needed because tool_call_update comes with a different ID
                this.emit({
                  type: 'tool-result',
                  toolName,
                  result: { status: 'approved', decision: result.decision },
                  callId: permissionId,
                });
              } else {
                // Denied or aborted - find cancel option
                const cancelOption = options.find((opt: any) => 
                  opt.optionId === 'cancel' || opt.name?.toLowerCase().includes('cancel')
                );
                if (cancelOption) {
                  optionId = cancelOption.optionId || 'cancel';
                }
                
                // Emit tool-result for denied/aborted
                this.emit({
                  type: 'tool-result',
                  toolName,
                  result: { status: 'denied', decision: result.decision },
                  callId: permissionId,
                });
              }
              
              return { outcome: { outcome: 'selected', optionId } };
            } catch (error) {
              // Log to file only, not console
              logger.debug('[AcpBackend] Error in permission handler:', error);
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

      // Initialize the connection with timeout and retry
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

      const initTimeout = this.transport.getInitTimeout();
      logger.debug(`[AcpBackend] Initializing connection (timeout: ${initTimeout}ms)...`);

      await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.initialize(initRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`Initialize timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'Initialize',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );
      logger.debug(`[AcpBackend] Initialize completed`);

      // Create a new session with retry
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

      logger.debug(`[AcpBackend] Creating new session...`);

      const sessionResponse = await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.newSession(newSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`New session timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
                }, initTimeout);
              }),
            ]);
            return result;
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
        },
        {
          operationName: 'NewSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );
      this.acpSessionId = sessionResponse.sessionId;
      logger.debug(`[AcpBackend] Session created: ${this.acpSessionId}`);

      this.emitIdleStatus();

      // Send initial prompt if provided
      if (initialPrompt) {
        this.sendPrompt(sessionId, initialPrompt).catch((error) => {
          // Log to file only, not console
          logger.debug('[AcpBackend] Error sending initial prompt:', error);
          this.emit({ type: 'status', status: 'error', detail: String(error) });
        });
      }

      return { sessionId };

    } catch (error) {
      // Log to file only, not console
      logger.debug('[AcpBackend] Error starting session:', error);
      this.emit({ 
        type: 'status', 
        status: 'error', 
        detail: error instanceof Error ? error.message : String(error) 
      });
      throw error;
    }
  }

  /**
   * Create handler context for session update processing
   */
  private createHandlerContext(): HandlerContext {
    return {
      transport: this.transport,
      activeToolCalls: this.activeToolCalls,
      toolCallStartTimes: this.toolCallStartTimes,
      toolCallTimeouts: this.toolCallTimeouts,
      toolCallIdToNameMap: this.toolCallIdToNameMap,
      idleTimeout: this.idleTimeout,
      toolCallCountSincePrompt: this.toolCallCountSincePrompt,
      emit: (msg) => this.emit(msg),
      emitIdleStatus: () => this.emitIdleStatus(),
      clearIdleTimeout: () => {
        if (this.idleTimeout) {
          clearTimeout(this.idleTimeout);
          this.idleTimeout = null;
        }
      },
      setIdleTimeout: (callback, ms) => {
        this.idleTimeout = setTimeout(() => {
          callback();
          this.idleTimeout = null;
        }, ms);
      },
    };
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const notification = params as ExtendedSessionNotification;
    const update = notification.update;

    if (!update) {
      logger.debug('[AcpBackend] Received session update without update field:', params);
      return;
    }

    const sessionUpdateType = update.sessionUpdate;

    // Log session updates for debugging (but not every chunk to avoid log spam)
    if (sessionUpdateType !== 'agent_message_chunk') {
      logger.debug(`[AcpBackend] Received session update: ${sessionUpdateType}`, JSON.stringify({
        sessionUpdate: sessionUpdateType,
        toolCallId: update.toolCallId,
        status: update.status,
        kind: update.kind,
        hasContent: !!update.content,
        hasLocations: !!update.locations,
      }, null, 2));
    }

    const ctx = this.createHandlerContext();

    // Dispatch to appropriate handler based on update type
    if (sessionUpdateType === 'agent_message_chunk') {
      handleAgentMessageChunk(update as SessionUpdate, ctx);
      return;
    }

    if (sessionUpdateType === 'tool_call_update') {
      const result = handleToolCallUpdate(update as SessionUpdate, ctx);
      if (result.toolCallCountSincePrompt !== undefined) {
        this.toolCallCountSincePrompt = result.toolCallCountSincePrompt;
      }
      return;
    }

    if (sessionUpdateType === 'agent_thought_chunk') {
      handleAgentThoughtChunk(update as SessionUpdate, ctx);
      return;
    }

    if (sessionUpdateType === 'tool_call') {
      handleToolCall(update as SessionUpdate, ctx);
      return;
    }

    // Handle legacy and auxiliary update types
    handleLegacyMessageChunk(update as SessionUpdate, ctx);
    handlePlanUpdate(update as SessionUpdate, ctx);
    handleThinkingUpdate(update as SessionUpdate, ctx);

    // Log unhandled session update types for debugging
    // Cast to string to avoid TypeScript errors (SDK types don't include all Gemini-specific update types)
    const updateTypeStr = sessionUpdateType as string;
    const handledTypes = ['agent_message_chunk', 'tool_call_update', 'agent_thought_chunk', 'tool_call'];
    if (updateTypeStr &&
        !handledTypes.includes(updateTypeStr) &&
        !update.messageChunk &&
        !update.plan &&
        !update.thinking) {
      logger.debug(`[AcpBackend] Unhandled session update type: ${updateTypeStr}`, JSON.stringify(update, null, 2));
    }
  }

  // Promise resolver for waitForIdle - set when waiting for response to complete
  private idleResolver: (() => void) | null = null;
  private waitingForResponse = false;

  async sendPrompt(sessionId: SessionId, prompt: string): Promise<void> {
    // Check if prompt contains change_title instruction (via optional callback)
    const promptHasChangeTitle = this.options.hasChangeTitleInstruction?.(prompt) ?? false;

    // Reset tool call counter and set flag
    this.toolCallCountSincePrompt = 0;
    this.recentPromptHadChangeTitle = promptHasChangeTitle;
    
    if (promptHasChangeTitle) {
      logger.debug('[AcpBackend] Prompt contains change_title instruction - will auto-approve first "other" tool call if it matches pattern');
    }
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    if (!this.connection || !this.acpSessionId) {
      throw new Error('Session not started');
    }

    this.emit({ type: 'status', status: 'running' });
    this.waitingForResponse = true;

    try {
      logger.debug(`[AcpBackend] Sending prompt (length: ${prompt.length}): ${prompt.substring(0, 100)}...`);
      logger.debug(`[AcpBackend] Full prompt: ${prompt}`);
      
      const contentBlock: ContentBlock = {
        type: 'text',
        text: prompt,
      };

      const promptRequest: PromptRequest = {
        sessionId: this.acpSessionId,
        prompt: [contentBlock],
      };

      logger.debug(`[AcpBackend] Prompt request:`, JSON.stringify(promptRequest, null, 2));
      await this.connection.prompt(promptRequest);
      logger.debug('[AcpBackend] Prompt request sent to ACP connection');
      
      // Don't emit 'idle' here - it will be emitted after all message chunks are received
      // The idle timeout in handleSessionUpdate will emit 'idle' after the last chunk

    } catch (error) {
      logger.debug('[AcpBackend] Error sending prompt:', error);
      this.waitingForResponse = false;
      
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

  /**
   * Wait for the response to complete (idle status after all chunks received)
   * Call this after sendPrompt to wait for Gemini to finish responding
   */
  async waitForResponseComplete(timeoutMs: number = 120000): Promise<void> {
    if (!this.waitingForResponse) {
      return; // Already completed or no prompt sent
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.idleResolver = null;
        this.waitingForResponse = false;
        reject(new Error('Timeout waiting for response to complete'));
      }, timeoutMs);

      this.idleResolver = () => {
        clearTimeout(timeout);
        this.idleResolver = null;
        this.waitingForResponse = false;
        resolve();
      };
    });
  }

  /**
   * Helper to emit idle status and resolve any waiting promises
   */
  private emitIdleStatus(): void {
    this.emit({ type: 'status', status: 'idle' });
    // Resolve any waiting promises
    if (this.idleResolver) {
      logger.debug('[AcpBackend] Resolving idle waiter');
      this.idleResolver();
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
      logger.debug('[AcpBackend] Error cancelling:', error);
    }
  }

  /**
   * Emit permission response event for UI/logging purposes.
   *
   * **IMPORTANT:** For ACP backends, this method does NOT send the actual permission
   * response to the agent. The ACP protocol requires synchronous permission handling,
   * which is done inside the `requestPermission` RPC handler via `this.options.permissionHandler`.
   *
   * This method only emits a `permission-response` event for:
   * - UI updates (e.g., closing permission dialogs)
   * - Logging and debugging
   * - Other parts of the CLI that need to react to permission decisions
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    logger.debug(`[AcpBackend] Permission response event (UI only): ${requestId} = ${approved}`);
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    
    logger.debug('[AcpBackend] Disposing backend');
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
        logger.debug('[AcpBackend] Error during graceful shutdown:', error);
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
            logger.debug('[AcpBackend] Force killing process');
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
