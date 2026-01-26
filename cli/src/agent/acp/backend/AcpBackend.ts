/**
 * AcpBackend - Agent Client Protocol backend using official SDK
 *
 * This module provides a universal backend implementation using the official
 * @agentclientprotocol/sdk. Agent-specific behavior (timeouts, filtering,
 * error handling) is delegated to TransportHandler implementations.
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
  type LoadSessionRequest,
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
} from '../../core';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import packageJson from '../../../../package.json';
import {
  type TransportHandler,
  type StderrContext,
  type ToolNameContext,
  DefaultTransport,
} from '../../transport';
import {
  type SessionUpdate,
  type HandlerContext,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  handleAgentMessageChunk,
  handleUserMessageChunk,
  handleAgentThoughtChunk,
  handleToolCallUpdate,
  handleToolCall,
  handleLegacyMessageChunk,
  handlePlanUpdate,
  handleThinkingUpdate,
  handleAvailableCommandsUpdate,
  handleCurrentModeUpdate,
} from './sessionUpdateHandlers';
import { nodeToWebStreams } from './nodeToWebStreams';
import {
  pickPermissionOutcome,
  type PermissionOptionLike,
} from '../permissions/permissionMapping';
import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  resolvePermissionToolName,
  type PermissionRequestLike,
} from '../permissions/permissionRequest';
import { AcpReplayCapture, type AcpReplayEvent } from '../history/acpReplayCapture';

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

/**
 * Extended RequestPermissionRequest with additional fields that may be present
 */
type ExtendedRequestPermissionRequest = RequestPermissionRequest & {
  toolCall?: {
    toolCallId?: string;
    id?: string;
    kind?: string;
    toolName?: string;
    rawInput?: Record<string, unknown>;
    input?: Record<string, unknown>;
    arguments?: Record<string, unknown>;
    content?: Record<string, unknown>;
  };
  kind?: string;
  rawInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  content?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    name?: string;
    kind?: string;
  }>;
};

// SessionNotification payload shape differs across ACP SDK versions (some use `update`, some use `updates[]`).
// We normalize dynamically in `handleSessionUpdate` and avoid relying on the SDK type here.

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
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort' }>;
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
  private replayCapture: AcpReplayCapture | null = null;
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
  private toolCallIdToInputMap = new Map<string, Record<string, unknown>>();

  /** Cache last selected permission option per tool call id (handles duplicate permission prompts) */
  private lastSelectedPermissionOptionIdByToolCallId = new Map<string, string>();

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

  private buildAcpMcpServersForSessionRequest(): NewSessionRequest['mcpServers'] {
    if (!this.options.mcpServers) return [] as unknown as NewSessionRequest['mcpServers'];
    const mcpServers = Object.entries(this.options.mcpServers).map(([name, config]) => ({
      name,
      command: config.command,
      args: config.args || [],
      env: config.env
        ? Object.entries(config.env).map(([envName, envValue]) => ({ name: envName, value: envValue }))
        : [],
    }));
    return mcpServers as unknown as NewSessionRequest['mcpServers'];
  }

  private async createConnectionAndInitialize(params: { operationId: string }): Promise<{ initTimeout: number }> {
    logger.debug(`[AcpBackend] Starting process + initializing connection (op=${params.operationId})`);

    if (this.process || this.connection) {
      throw new Error('ACP backend is already initialized');
    }

    try {
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
        const options = extendedParams.options || [];
        // ACP spec: toolCall.toolCallId is the correlation ID. Fall back to legacy fields when needed.
        const toolCallId =
          (typeof toolCall?.toolCallId === 'string' && toolCall.toolCallId.trim().length > 0)
            ? toolCall.toolCallId.trim()
            : (typeof toolCall?.id === 'string' && toolCall.id.trim().length > 0)
              ? toolCall.id.trim()
              : randomUUID();
        const permissionId = toolCallId;

        const toolNameHint = extractPermissionToolNameHint(extendedParams as PermissionRequestLike);
        const input = extractPermissionInputWithFallback(
          extendedParams as PermissionRequestLike,
          toolCallId,
          this.toolCallIdToInputMap
        );
        let toolName = resolvePermissionToolName({
          toolNameHint,
          toolCallId,
          toolCallIdToNameMap: this.toolCallIdToNameMap,
        });

        // If the agent re-prompts with the same toolCallId, reuse the previous selection when possible.
        const cachedOptionId = this.lastSelectedPermissionOptionIdByToolCallId.get(toolCallId);
        if (cachedOptionId && options.some((opt) => opt.optionId === cachedOptionId)) {
          logger.debug(`[AcpBackend] Duplicate permission prompt for ${toolCallId}, reusing cached optionId=${cachedOptionId}`);
          return { outcome: { outcome: 'selected', optionId: cachedOptionId } };
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

        const inputKeys = input && typeof input === 'object' && !Array.isArray(input)
          ? Object.keys(input as Record<string, unknown>)
          : [];
        logger.debug(`[AcpBackend] Permission request: tool=${toolName}, toolCallId=${toolCallId}, inputKeys=${inputKeys.join(',')}`);
        logger.debug(`[AcpBackend] Permission request params structure:`, JSON.stringify({
          hasToolCall: !!toolCall,
          toolCallToolCallId: toolCall?.toolCallId,
          toolCallKind: toolCall?.kind,
          toolCallToolName: toolCall?.toolName,
          toolCallId: toolCall?.id,
          paramsKind: extendedParams.kind,
          options: options.map((opt) => ({ optionId: opt.optionId, kind: opt.kind, name: opt.name })),
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

            const isApproved = result.decision === 'approved'
              || result.decision === 'approved_for_session'
              || result.decision === 'approved_execpolicy_amendment';

            await this.respondToPermission(permissionId, isApproved);
            const outcome = pickPermissionOutcome(options as PermissionOptionLike[], result.decision);
            if (outcome.outcome === 'selected') {
              this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
            } else {
              this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
            }
            return { outcome };
          } catch (error) {
            // Log to file only, not console
            logger.debug('[AcpBackend] Error in permission handler:', error);
            // Fallback to deny on error
            return { outcome: { outcome: 'cancelled' } };
          }
        }

        // Auto-approve once if no permission handler.
        const outcome = pickPermissionOutcome(options as PermissionOptionLike[], 'approved');
        if (outcome.outcome === 'selected') {
          this.lastSelectedPermissionOptionIdByToolCallId.set(toolCallId, outcome.optionId);
        } else {
          this.lastSelectedPermissionOptionIdByToolCallId.delete(toolCallId);
        }
        return { outcome };
      },
    };

    // Create ClientSideConnection
    this.connection = new ClientSideConnection(
      (_agent: Agent) => client,
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
    return { initTimeout };
    } catch (error) {
      logger.debug('[AcpBackend] Initialization failed; cleaning up process/connection', error);
      const proc = this.process;
      this.process = null;
      this.connection = null;
      this.acpSessionId = null;
      if (proc) {
        try {
          // On Windows, signals are not reliably supported; `kill()` uses TerminateProcess.
          if (process.platform === 'win32') {
            proc.kill();
          } else {
            proc.kill('SIGTERM');
          }
        } catch {
          // best-effort cleanup
        }
      }
      throw error;
    }
  }

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      // Create a new session with retry
      const newSessionRequest: NewSessionRequest = {
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest(),
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
      const sessionId = sessionResponse.sessionId;
      logger.debug(`[AcpBackend] Session created: ${sessionId}`);

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

  async loadSession(sessionId: SessionId): Promise<StartSessionResult> {
    if (this.disposed) {
      throw new Error('Backend has been disposed');
    }

    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalized) {
      throw new Error('Session ID is required');
    }

    this.emit({ type: 'status', status: 'starting' });
    // Reset per-session caches
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();

    try {
      const { initTimeout } = await this.createConnectionAndInitialize({ operationId: randomUUID() });

      const loadSessionRequest: LoadSessionRequest = {
        sessionId: normalized,
        cwd: this.options.cwd,
        mcpServers: this.buildAcpMcpServersForSessionRequest() as unknown as LoadSessionRequest['mcpServers'],
      };

      logger.debug(`[AcpBackend] Loading session: ${normalized}`);

      await withRetry(
        async () => {
          let timeoutHandle: NodeJS.Timeout | null = null;
          try {
            const result = await Promise.race([
              this.connection!.loadSession(loadSessionRequest).then((res) => {
                if (timeoutHandle) {
                  clearTimeout(timeoutHandle);
                  timeoutHandle = null;
                }
                return res;
              }),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  reject(new Error(`Load session timeout after ${initTimeout}ms - ${this.transport.agentName} did not respond`));
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
          operationName: 'LoadSession',
          maxAttempts: RETRY_CONFIG.maxAttempts,
          baseDelayMs: RETRY_CONFIG.baseDelayMs,
          maxDelayMs: RETRY_CONFIG.maxDelayMs,
        }
      );

      this.acpSessionId = normalized;
      logger.debug(`[AcpBackend] Session loaded: ${normalized}`);

      this.emitIdleStatus();
      return { sessionId: normalized };
    } catch (error) {
      logger.debug('[AcpBackend] Error loading session:', error);
      this.emit({
        type: 'status',
        status: 'error',
        detail: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async loadSessionWithReplayCapture(sessionId: SessionId): Promise<StartSessionResult & { replay: AcpReplayEvent[] }> {
    this.replayCapture = new AcpReplayCapture();
    try {
      const result = await this.loadSession(sessionId);
      const replay = this.replayCapture.finalize();
      return { ...result, replay };
    } finally {
      this.replayCapture = null;
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
      toolCallIdToInputMap: this.toolCallIdToInputMap,
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
    const raw = params as unknown as Record<string, unknown>;
    const update = (
      (raw as any).update
      ?? (Array.isArray((raw as any).updates) ? (raw as any).updates[0] : undefined)
    ) as SessionUpdate | undefined;

    if (!update) {
      logger.debug('[AcpBackend] Received session update without update field:', params);
      return;
    }

    const sessionUpdateType = (update as any).sessionUpdate as string | undefined;

    const isGeminiAcpDebugEnabled = (() => {
      const stacks = process.env.HAPPY_STACKS_GEMINI_ACP_DEBUG;
      const local = process.env.HAPPY_LOCAL_GEMINI_ACP_DEBUG;
      return stacks === '1' || local === '1' || stacks === 'true' || local === 'true';
    })();

    const sanitizeForLogs = (value: unknown, depth = 0): unknown => {
      if (depth > 4) return '[truncated depth]';
      if (typeof value === 'string') {
        const max = 400;
        if (value.length <= max) return value;
        return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
      }
      if (Array.isArray(value)) {
        if (value.length > 50) {
          return [...value.slice(0, 50).map((v) => sanitizeForLogs(v, depth + 1)), `… [truncated ${value.length - 50} items]`];
        }
        return value.map((v) => sanitizeForLogs(v, depth + 1));
      }
      if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = sanitizeForLogs(v, depth + 1);
        }
        return out;
      }
      return value;
    };

    if (this.replayCapture) {
      try {
        this.replayCapture.handleUpdate(update as SessionUpdate);
      } catch (error) {
        logger.debug('[AcpBackend] Replay capture failed (non-fatal)', { error });
      }

      // Suppress transcript-affecting updates during loadSession replay.
      const suppress = sessionUpdateType === 'user_message_chunk'
        || sessionUpdateType === 'agent_message_chunk'
        || sessionUpdateType === 'agent_thought_chunk'
        || sessionUpdateType === 'tool_call'
        || sessionUpdateType === 'tool_call_update'
        || sessionUpdateType === 'plan';
      if (suppress) {
        return;
      }
    }

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

    // Gemini ACP deep debug: dump raw terminal tool updates to verify where tool outputs live.
    if (
      isGeminiAcpDebugEnabled &&
      this.transport.agentName === 'gemini' &&
      (sessionUpdateType === 'tool_call_update' || sessionUpdateType === 'tool_call') &&
      (update.status === 'completed' || update.status === 'failed' || update.status === 'cancelled')
    ) {
      const keys = Object.keys(update as any);
      logger.debug('[AcpBackend] [GeminiACP] Terminal tool update keys:', keys);
      logger.debug('[AcpBackend] [GeminiACP] Terminal tool update payload:', JSON.stringify(sanitizeForLogs(update), null, 2));
    }

    const ctx = this.createHandlerContext();

    // Dispatch to appropriate handler based on update type
    if (sessionUpdateType === 'agent_message_chunk') {
      handleAgentMessageChunk(update as SessionUpdate, ctx);
      return;
    }

    if (sessionUpdateType === 'user_message_chunk') {
      handleUserMessageChunk(update as SessionUpdate, ctx);
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

    if (sessionUpdateType === 'available_commands_update') {
      handleAvailableCommandsUpdate(update as SessionUpdate, ctx);
      return;
    }

    if (sessionUpdateType === 'current_mode_update') {
      handleCurrentModeUpdate(update as SessionUpdate, ctx);
      return;
    }

    if (sessionUpdateType === 'plan') {
      handlePlanUpdate(update as SessionUpdate, ctx);
      return;
    }

    // Handle legacy and auxiliary update types
    handleLegacyMessageChunk(update as SessionUpdate, ctx);
    handlePlanUpdate(update as SessionUpdate, ctx);
    handleThinkingUpdate(update as SessionUpdate, ctx);

    // Log unhandled session update types for debugging
    // Cast to string to avoid TypeScript errors (SDK types don't include all Gemini-specific update types)
    const updateTypeStr = sessionUpdateType as string;
    const handledTypes = [
      'agent_message_chunk',
      'user_message_chunk',
      'tool_call_update',
      'agent_thought_chunk',
      'tool_call',
      'available_commands_update',
      'current_mode_update',
      'plan',
    ];
    const updateAny = update as any;
    if (updateTypeStr &&
        !handledTypes.includes(updateTypeStr) &&
        !updateAny.messageChunk &&
        !updateAny.plan &&
        !updateAny.thinking &&
        !updateAny.availableCommands &&
        !updateAny.currentModeId &&
        !updateAny.entries) {
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
    this.permissionToToolCallMap.clear();
    this.toolCallIdToNameMap.clear();
    this.toolCallIdToInputMap.clear();
    this.lastSelectedPermissionOptionIdByToolCallId.clear();
  }
}
