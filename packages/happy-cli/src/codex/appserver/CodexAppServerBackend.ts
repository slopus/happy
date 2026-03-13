/**
 * CodexAppServerBackend - AgentBackend implementation for Codex app-server
 *
 * Communicates with the Codex CLI in app-server mode via JSON-RPC over stdin/stdout.
 * Implements the AgentBackend interface so it can be used interchangeably with AcpBackend.
 *
 * Protocol flow:
 *   initialize → initialized → newConversation/resumeConversation
 *   → addConversationListener → sendUserMessage → [events stream]
 *   → task_complete/turn_aborted
 */

import { CodexJsonRpcPeer } from './CodexJsonRpcPeer';
import {
  Methods,
  type InitializeParams,
  type InitializeResponse,
  type NewConversationParams,
  type NewConversationResponse,
  type ResumeConversationParams,
  type ResumeConversationResponse,
  type AddConversationListenerParams,
  type AddConversationListenerResponse,
  type SendUserMessageParams,
  type SendUserMessageResponse,
  type InputItem,
  type ApplyPatchApprovalParams,
  type ExecCommandApprovalParams,
  type ReviewDecision,
  type ApprovalPolicy,
  type SandboxMode,
  type InterruptConversationParams,
  type RawCodexEvent,
} from './types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  McpServerConfig,
  SessionId,
  SendPromptOptions,
  StartSessionResult,
} from '@/agent/core';
import { logger } from '@/ui/logger';

// ─── Options ────────────────────────────────────────────────────

export interface CodexPermissionHandler {
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'denied' | 'abort' }>;
}

export interface CodexAppServerBackendOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Command to run (e.g. 'codex') */
  command: string;
  /** Arguments (e.g. ['app-server']) */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Model to use */
  model?: string | null;
  /** Model reasoning effort */
  reasoningEffort?: string | null;
  /** Approval policy */
  approvalPolicy?: ApprovalPolicy | null;
  /** Sandbox mode */
  sandbox?: SandboxMode | null;
  /** Base instructions (system prompt) for the agent */
  baseInstructions?: string | null;
  /** MCP servers config (for happy change_title etc.) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Rollout file path for session resume */
  resumeFile?: string | null;
  /** Permission handler for tool approvals */
  permissionHandler?: CodexPermissionHandler;
  /** Abort signal */
  signal?: AbortSignal;
}

// ─── Pending Approval ───────────────────────────────────────────

interface PendingApproval {
  jsonRpcId: number | string;
  callId: string;
}

type ApprovalParams = Record<string, unknown>;

// Event types that indicate real turn progress and should reset idle timeout.
const TURN_PROGRESS_EVENT_TYPES = new Set<string>([
  'task_started',
  'agent_message_delta',
  'agent_message_content_delta',
  'agent_message',
  'agent_reasoning_delta',
  'reasoning_content_delta',
  'agent_reasoning',
  'agent_reasoning_section_break',
  'exec_command_begin',
  'exec_command_end',
  'exec_command_output_delta',
  'exec_approval_request',
  'patch_apply_begin',
  'patch_apply_end',
  'apply_patch_approval_request',
  'mcp_tool_call_begin',
  'mcp_tool_call_end',
  'web_search_begin',
  'web_search_end',
  'view_image_tool_call',
  'turn_diff',
  'plan_update',
  'context_compacted',
  'item_started',
  'item_completed',
  'background_event',
  'task_complete',
  'turn_aborted',
  'shutdown_complete',
]);

export function isTurnProgressEvent(eventType: string): boolean {
  return TURN_PROGRESS_EVENT_TYPES.has(eventType);
}

// ─── Backend ────────────────────────────────────────────────────

export class CodexAppServerBackend implements AgentBackend {
  private peer: CodexJsonRpcPeer;
  private listeners: AgentMessageHandler[] = [];
  private conversationId: string | null = null;
  private sessionId: string | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private feedbackQueue: string[] = [];
  private disposed = false;

  // Resolvers for waitForResponseComplete()
  private turnCompleteResolve: (() => void) | null = null;
  private turnCompletePromise: Promise<void> | null = null;
  private turnCompleteSettled = false;
  private turnCompletionError: Error | null = null;
  private turnStartedAt = 0;
  private turnLastProgressAt = 0;
  private turnLastProgressEvent: string | null = null;

  constructor(private readonly options: CodexAppServerBackendOptions) {
    this.peer = new CodexJsonRpcPeer();
  }

  // ─── AgentBackend Interface ─────────────────────────────────

  async startSession(initialPrompt?: string): Promise<StartSessionResult> {
    // 1. Spawn the app-server process
    const command = this.options.command;
    const args = this.options.args ?? ['app-server'];

    await this.peer.spawn(command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      signal: this.options.signal,
    });

    // 2. Register handlers before initialize (events may arrive early)
    this.peer.onNotification((method, params) => this.handleNotification(method, params));
    this.peer.onServerRequest((method, params, id) => this.handleServerRequest(method, params, id));
    this.peer.onClose(() => {
      if (!this.turnCompletePromise || this.turnCompleteSettled) {
        return;
      }
      if (this.disposed) {
        this.resolveTurnComplete();
      } else {
        this.resolveTurnComplete(new Error('Codex app-server closed before turn completed'));
      }
    });

    // 3. Initialize handshake
    await this.peer.request<InitializeResponse>(Methods.INITIALIZE, {
      clientInfo: {
        name: 'happy-codex-backend',
        version: '0.14.0',
      },
      capabilities: null,
    } satisfies InitializeParams);

    this.peer.notify(Methods.INITIALIZED);

    // 4. Create or resume conversation
    let convId: string;

    if (this.options.resumeFile) {
      const resumeResult = await this.peer.request<ResumeConversationResponse>(
        Methods.RESUME_CONVERSATION,
        {
          path: this.options.resumeFile,
          overrides: this.buildConversationParams(),
        } satisfies ResumeConversationParams
      );
      convId = resumeResult.conversationId;
      this.handleSessionConfigured({ sessionId: convId, model: resumeResult.model, reasoningEffort: resumeResult.reasoningEffort });
    } else {
      const newResult = await this.peer.request<NewConversationResponse>(
        Methods.NEW_CONVERSATION,
        this.buildConversationParams()
      );
      convId = newResult.conversationId;
      logger.info(`[CodexBackend] New conversation: id=${convId}, model=${newResult.model}`);
      this.handleSessionConfigured({ sessionId: convId, model: newResult.model, reasoningEffort: newResult.reasoningEffort });
    }

    this.conversationId = convId;
    this.sessionId = convId; // Use conversationId as sessionId

    // 5. Subscribe to events
    await this.peer.request<AddConversationListenerResponse>(
      Methods.ADD_CONVERSATION_LISTENER,
      {
        conversationId: convId,
        experimentalRawEvents: false,
      } satisfies AddConversationListenerParams
    );

    // 6. Send initial prompt if provided
    if (initialPrompt) {
      this.resetTurnComplete();
      await this.doSendMessage(initialPrompt);
    }

    return { sessionId: convId };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string, options?: SendPromptOptions): Promise<void> {
    if (!this.conversationId) {
      throw new Error('CodexAppServerBackend: no active conversation');
    }

    // Flush feedback queue (denied approval reasons from previous turn)
    await this.flushFeedbackQueue();

    // Reset turn-complete promise for the new turn
    this.resetTurnComplete();

    await this.doSendMessage(prompt, options);
  }

  async cancel(_sessionId: SessionId): Promise<void> {
    if (!this.conversationId || !this.peer.isAlive) return;

    try {
      await this.peer.request(Methods.INTERRUPT_CONVERSATION, {
        conversationId: this.conversationId,
      } satisfies InterruptConversationParams, 5000);
    } catch {
      // Interrupt may fail if already completed - ignore
      logger.debug('[CodexBackend] Interrupt failed (process may have already exited)');
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.listeners.push(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    const idx = this.listeners.indexOf(handler);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  async respondToPermission(requestId: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) {
      logger.debug(`[CodexBackend] No pending approval for requestId=${requestId}`);
      return;
    }

    this.pendingApprovals.delete(requestId);

    const decision: ReviewDecision = approved ? 'approved' : 'denied';

    // Send the response back to Codex
    this.peer.respond(pending.jsonRpcId, { decision });

    // Emit permission-response for UI
    this.emit({ type: 'permission-response', id: requestId, approved });
  }

  async waitForResponseComplete(timeoutMs = 300_000): Promise<void> {
    if (!this.turnCompletePromise) {
      this.resetTurnComplete();
    }

    const idleTimeoutMs = timeoutMs;
    const checkIntervalMs = Math.max(100, Math.min(1000, Math.floor(idleTimeoutMs / 10)));

    let timer: ReturnType<typeof setInterval> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setInterval(() => {
        // Don't timeout while waiting for user to approve/deny a request
        if (this.pendingApprovals.size > 0) {
          this.turnLastProgressAt = Date.now();
          return;
        }

        const now = Date.now();
        const lastProgressAt = this.turnLastProgressAt || this.turnStartedAt || now;
        const idleMs = now - lastProgressAt;
        if (idleMs < idleTimeoutMs) {
          return;
        }

        const elapsedMs = this.turnStartedAt ? now - this.turnStartedAt : idleMs;
        const lastProgressEvent = this.turnLastProgressEvent ?? 'none';
        reject(
          new Error(
            `waitForResponseComplete idle timeout after ${idleTimeoutMs}ms ` +
            `(idle=${idleMs}ms, elapsed=${elapsedMs}ms, ` +
            `lastProgressEvent=${lastProgressEvent}, pendingApprovals=${this.pendingApprovals.size})`
          )
        );
      }, checkIntervalMs);
    });

    try {
      await Promise.race([this.turnCompletePromise!, timeout]);
      if (this.turnCompletionError) {
        throw this.turnCompletionError;
      }
    } finally {
      if (timer) {
        clearInterval(timer);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // Reject all pending approvals
    for (const [, pending] of this.pendingApprovals) {
      this.peer.respond(pending.jsonRpcId, { decision: 'abort' as ReviewDecision });
    }
    this.pendingApprovals.clear();

    // Resolve any waitForResponseComplete
    this.resolveTurnComplete();

    await this.peer.close();
  }

  // ─── Conversation Params ────────────────────────────────────

  private buildConversationParams(): NewConversationParams {
    const params: NewConversationParams = {
      cwd: this.options.cwd,
    };

    if (this.options.model) params.model = this.options.model;
    if (this.options.approvalPolicy) params.approvalPolicy = this.options.approvalPolicy;
    if (this.options.sandbox) params.sandbox = this.options.sandbox;
    if (this.options.baseInstructions) params.baseInstructions = this.options.baseInstructions;

    // Build config overrides (MCP servers + reasoning effort)
    const config: Record<string, unknown> = {};
    if (this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0) {
      config.mcp_servers = this.options.mcpServers;
    }
    // Reasoning effort must be passed via config (model_reasoning_effort)
    // because NewConversationParams doesn't have a dedicated field for it.
    if (this.options.reasoningEffort) {
      config.model_reasoning_effort = this.options.reasoningEffort;
    }
    if (Object.keys(config).length > 0) {
      params.config = config;
    }

    return params;
  }

  // ─── Message Sending ────────────────────────────────────────

  private async doSendMessage(prompt: string, options?: SendPromptOptions): Promise<void> {
    if (!this.conversationId) return;

    const items: InputItem[] = [];

    // Add images if present
    if (options?.images?.length) {
      for (const img of options.images) {
        items.push({
          type: 'image',
          data: { image_url: `data:${img.mimeType};base64,${img.data}` },
        });
      }
    }

    // Add text
    items.push({
      type: 'text',
      data: { text: prompt, textElements: [] },
    });

    await this.peer.request<SendUserMessageResponse>(Methods.SEND_USER_MESSAGE, {
      conversationId: this.conversationId,
      items,
    } satisfies SendUserMessageParams);
  }

  private async flushFeedbackQueue(): Promise<void> {
    while (this.feedbackQueue.length > 0) {
      const feedback = this.feedbackQueue.shift()!;
      await this.doSendMessage(`User feedback: ${feedback}`);
    }
  }

  // ─── Turn Complete ──────────────────────────────────────────

  private resetTurnComplete(): void {
    const now = Date.now();
    this.turnStartedAt = now;
    this.turnLastProgressAt = now;
    this.turnLastProgressEvent = 'turn_start';
    this.turnCompletionError = null;
    this.turnCompleteSettled = false;
    this.turnCompletePromise = new Promise<void>((resolve) => {
      this.turnCompleteResolve = resolve;
    });
  }

  private resolveTurnComplete(error?: Error): void {
    if (!this.turnCompletePromise || this.turnCompleteSettled) {
      return;
    }
    this.turnCompleteSettled = true;
    this.turnCompletionError = error ?? null;
    this.turnCompleteResolve?.();
    this.turnCompleteResolve = null;
  }

  private markTurnProgress(eventType: string): void {
    if (!this.turnCompletePromise || this.turnCompleteSettled) {
      return;
    }
    this.turnLastProgressAt = Date.now();
    this.turnLastProgressEvent = eventType;
  }

  // ─── Emit ───────────────────────────────────────────────────

  private emit(msg: AgentMessage): void {
    for (const handler of this.listeners) {
      try {
        handler(msg);
      } catch (err) {
        logger.debug(`[CodexBackend] Message handler error: ${err}`);
      }
    }
  }

  // ─── Notification Handler ───────────────────────────────────

  private handleNotification(method: string, params: unknown): void {
    // Codex events come as "codex/event" or "codex/event/<type>"
    if (!method.startsWith(Methods.EVENT_PREFIX)) {
      // sessionConfigured comes as a separate notification (camelCase)
      if (method === 'sessionConfigured') {
        this.handleSessionConfigured(params);
      }
      return;
    }

    // Extract event msg from params
    const eventParams = params as { msg?: RawCodexEvent } | null;
    const msg = eventParams?.msg;
    if (!msg) return;

    this.handleCodexEvent(msg);
  }

  private handleSessionConfigured(params: unknown): void {
    const p = params as Record<string, unknown>;
    const sessionId =
      typeof p?.sessionId === 'string'
        ? p.sessionId
        : typeof p?.session_id === 'string'
          ? p.session_id
          : undefined;
    const model = typeof p?.model === 'string' ? p.model : undefined;
    const reasoningEffort =
      typeof p?.reasoningEffort === 'string'
        ? p.reasoningEffort
        : typeof p?.reasoning_effort === 'string'
          ? p.reasoning_effort
          : undefined;

    if (sessionId) {
      this.sessionId = sessionId;
    }
    logger.debug(`[CodexBackend] Session configured: model=${model}, sessionId=${sessionId}`);
    this.emit({
      type: 'event',
      name: 'session_configured',
      payload: {
        sessionId,
        model,
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      },
    });
  }

  // ─── Event Mapping ──────────────────────────────────────────

  private handleCodexEvent(raw: RawCodexEvent): void {
    if (isTurnProgressEvent(raw.type)) {
      this.markTurnProgress(raw.type);
    }

    // Cast to any-typed record for property access — the switch narrows logically
    const event = raw as Record<string, any>;
    switch (raw.type) {
      // ── Model output ──
      case 'agent_message_delta':
      case 'agent_message_content_delta':
        this.emit({ type: 'model-output', textDelta: event.delta });
        break;

      case 'agent_message':
        this.emit({ type: 'model-output', fullText: event.message });
        break;

      // ── Reasoning ──
      case 'agent_reasoning_delta':
      case 'reasoning_content_delta':
        this.emit({ type: 'event', name: 'reasoning_delta', payload: { delta: event.delta } });
        break;

      case 'agent_reasoning':
        this.emit({ type: 'event', name: 'reasoning', payload: { text: event.text } });
        break;

      case 'agent_reasoning_section_break':
        this.emit({ type: 'event', name: 'reasoning_section_break', payload: event });
        break;

      // ── Command execution ──
      case 'exec_command_begin':
        this.emit({
          type: 'tool-call',
          toolName: 'CodexBash',
          callId: event.call_id,
          args: { command: event.command, cwd: event.cwd },
        });
        break;

      case 'exec_command_end':
        this.emit({
          type: 'tool-result',
          toolName: 'CodexBash',
          callId: event.call_id,
          result: {
            stdout: event.stdout,
            stderr: event.stderr,
            exit_code: event.exit_code,
            formatted_output: event.formatted_output,
          },
        });
        break;

      case 'exec_command_output_delta':
        this.emit({
          type: 'terminal-output',
          data: Buffer.from(event.chunk).toString(),
        });
        break;

      // ── Exec approval request (event form) ──
      case 'exec_approval_request':
        this.emit({
          type: 'exec-approval-request',
          call_id: event.call_id,
          command: event.command,
          cwd: event.cwd,
          reason: event.reason,
        });
        break;

      // ── Patch operations ──
      case 'patch_apply_begin':
        this.emit({
          type: 'patch-apply-begin',
          call_id: event.call_id,
          auto_approved: event.auto_approved,
          changes: event.changes,
        });
        break;

      case 'patch_apply_end':
        this.emit({
          type: 'patch-apply-end',
          call_id: event.call_id,
          stdout: event.stdout,
          stderr: event.stderr,
          success: event.success,
        });
        break;

      // ── Apply patch approval request (event form) ──
      case 'apply_patch_approval_request':
        this.emit({
          type: 'permission-request',
          id: event.call_id,
          reason: event.reason ?? 'File edit approval requested',
          payload: { type: 'patch', changes: event.changes },
        });
        break;

      // ── MCP tool calls ──
      case 'mcp_tool_call_begin':
        this.emit({
          type: 'tool-call',
          toolName: `mcp:${event.invocation.server}:${event.invocation.tool}`,
          callId: event.call_id,
          args: (event.invocation.arguments ?? {}) as Record<string, unknown>,
        });
        break;

      case 'mcp_tool_call_end':
        this.emit({
          type: 'tool-result',
          toolName: `mcp:${event.invocation.server}:${event.invocation.tool}`,
          callId: event.call_id,
          result: event.result,
        });
        break;

      // ── Web search ──
      case 'web_search_begin':
        this.emit({
          type: 'tool-call',
          toolName: 'web_search',
          callId: event.call_id,
          args: {},
        });
        break;

      case 'web_search_end':
        this.emit({
          type: 'tool-result',
          toolName: 'web_search',
          callId: event.call_id,
          result: { query: event.query, action: event.action },
        });
        break;

      // ── Image viewing ──
      case 'view_image_tool_call':
        this.emit({
          type: 'tool-call',
          toolName: 'view_image',
          callId: event.call_id,
          args: { path: event.path },
        });
        break;

      // ── Task lifecycle ──
      case 'task_started':
        this.emit({ type: 'status', status: 'running' });
        break;

      case 'task_complete':
        this.emit({ type: 'status', status: 'idle' });
        this.resolveTurnComplete();
        break;

      case 'turn_aborted':
        this.emit({ type: 'status', status: 'idle', detail: 'aborted' });
        this.resolveTurnComplete();
        break;

      // ── Token count ──
      case 'token_count':
        this.emit({
          type: 'token-count',
          ...(event.info ?? {}),
          rate_limits: event.rate_limits,
        });
        break;

      // ── Turn diff ──
      case 'turn_diff':
        this.emit({ type: 'event', name: 'turn_diff', payload: { unified_diff: event.unified_diff } });
        break;

      // ── Plan updates ──
      case 'plan_update':
        this.emit({ type: 'event', name: 'plan_update', payload: { explanation: event.explanation, plan: event.plan } });
        break;

      // ── Context compacted ──
      case 'context_compacted':
        this.emit({ type: 'event', name: 'context_compacted', payload: event });
        break;

      // ── Errors/warnings ──
      // Codex may emit transient errors (e.g. "Reconnecting... 1/5") while recovering
      // internally.  Don't terminate the turn — just surface the error to the UI and
      // keep waiting for `task_complete`.  If Codex truly crashes the process will
      // exit, which is handled separately by the process-exit path.
      case 'stream_error':
      case 'error': {
        const errorDetail = typeof event.message === 'string' ? event.message : JSON.stringify(event.message);
        const message = errorDetail && errorDetail !== 'undefined' ? errorDetail : 'Codex event error';
        this.emit({ type: 'status', status: 'error', detail: message });
        break;
      }

      case 'warning':
        this.emit({ type: 'event', name: 'warning', payload: { message: event.message } });
        break;

      // ── Session configured (may also appear as event) ──
      case 'session_configured':
        this.handleSessionConfigured(event);
        break;

      case 'background_event':
        this.emit({ type: 'event', name: 'background', payload: { message: event.message } });
        break;

      case 'shutdown_complete':
        this.emit({ type: 'status', status: 'stopped' });
        this.resolveTurnComplete();
        break;

      // ── MCP startup progress ──
      case 'mcp_startup_update':
        this.emit({ type: 'event', name: 'mcp_startup', payload: { server: event.server, status: event.status } });
        break;

      case 'mcp_startup_complete':
        this.emit({ type: 'event', name: 'mcp_startup_complete', payload: { ready: event.ready, failed: event.failed, cancelled: event.cancelled } });
        break;

      // ── Informational events (no action needed) ──
      case 'skills_update_available':
      case 'item_started':
      case 'item_completed':
      case 'user_message':
        // Silently ignore — these are informational
        break;

      default:
        // Unknown events logged at debug level
        logger.debug(`[CodexBackend] Unhandled event: ${event.type}`);
        break;
    }
  }

  // ─── Server Request Handler (Approvals) ─────────────────────

  private handleServerRequest(method: string, params: unknown, id: number | string): void {
    switch (method) {
      case Methods.APPLY_PATCH_APPROVAL:
        this.handlePatchApproval(params as ApplyPatchApprovalParams, id);
        break;

      case Methods.EXEC_COMMAND_APPROVAL:
        this.handleExecApproval(params as ExecCommandApprovalParams, id);
        break;

      default:
        // Unknown server requests - respond with null to unblock
        logger.debug(`[CodexBackend] Unknown server request: ${method}`);
        this.peer.respond(id, null);
        break;
    }
  }

  private handlePatchApproval(params: ApplyPatchApprovalParams, jsonRpcId: number | string): void {
    const rawParams = params as unknown as ApprovalParams;
    const callId = this.getApprovalCallId(rawParams);
    if (!callId) {
      logger.warn('[CodexBackend] applyPatchApproval missing callId/call_id; denying request');
      this.peer.respond(jsonRpcId, { decision: 'denied' as ReviewDecision });
      return;
    }

    const reason = this.getApprovalReason(rawParams);
    const changes = this.getPatchChanges(rawParams);

    if (this.options.permissionHandler) {
      // Store pending approval for respondToPermission()
      this.pendingApprovals.set(callId, { jsonRpcId, callId });

      // Delegate to permission handler
      this.options.permissionHandler
        .handleToolCall(callId, 'CodexPatch', {
          changes,
          reason,
        })
        .then((result) => {
          // If still pending (not already responded via respondToPermission)
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            const decision = this.mapDecision(result.decision);
            this.peer.respond(jsonRpcId, { decision });

            // Queue feedback for denied/abort with reason
            if ((decision === 'denied' || decision === 'abort') && reason) {
              this.feedbackQueue.push(reason);
            }
          }
        })
        .catch(() => {
          // Permission handler error/cancel - deny
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            this.peer.respond(jsonRpcId, { decision: 'denied' as ReviewDecision });
          }
        });
    } else {
      // No handler - auto-approve
      this.peer.respond(jsonRpcId, { decision: 'approved' as ReviewDecision });
    }
  }

  private handleExecApproval(params: ExecCommandApprovalParams, jsonRpcId: number | string): void {
    const rawParams = params as unknown as ApprovalParams;
    const callId = this.getApprovalCallId(rawParams);
    if (!callId) {
      logger.warn('[CodexBackend] execCommandApproval missing callId/call_id; denying request');
      this.peer.respond(jsonRpcId, { decision: 'denied' as ReviewDecision });
      return;
    }

    const reason = this.getApprovalReason(rawParams);
    const command = this.getExecCommand(rawParams);
    const cwd = this.getExecCwd(rawParams);

    if (this.options.permissionHandler) {
      this.pendingApprovals.set(callId, { jsonRpcId, callId });

      this.options.permissionHandler
        .handleToolCall(callId, 'CodexBash', {
          command,
          cwd,
          reason,
        })
        .then((result) => {
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            const decision = this.mapDecision(result.decision);
            this.peer.respond(jsonRpcId, { decision });

            // Queue feedback for denied/abort with reason
            if ((decision === 'denied' || decision === 'abort') && reason) {
              this.feedbackQueue.push(reason);
            }
          }
        })
        .catch(() => {
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            this.peer.respond(jsonRpcId, { decision: 'denied' as ReviewDecision });
          }
        });
    } else {
      this.peer.respond(jsonRpcId, { decision: 'approved' as ReviewDecision });
    }
  }

  private mapDecision(decision: string): ReviewDecision {
    switch (decision) {
      case 'approved': return 'approved';
      case 'approved_for_session': return 'approved_for_session';
      case 'abort': return 'abort';
      case 'denied':
      default:
        return 'denied';
    }
  }

  private getApprovalCallId(params: ApprovalParams): string | null {
    if (typeof params.callId === 'string' && params.callId.length > 0) {
      return params.callId;
    }
    if (typeof params.call_id === 'string' && params.call_id.length > 0) {
      return params.call_id;
    }
    return null;
  }

  private getApprovalReason(params: ApprovalParams): string | undefined {
    if (typeof params.reason === 'string' && params.reason.length > 0) {
      return params.reason;
    }
    return undefined;
  }

  private getPatchChanges(params: ApprovalParams): Record<string, unknown> {
    const fileChanges = params.fileChanges;
    if (fileChanges && typeof fileChanges === 'object') {
      return fileChanges as Record<string, unknown>;
    }
    const snakeFileChanges = params.file_changes;
    if (snakeFileChanges && typeof snakeFileChanges === 'object') {
      return snakeFileChanges as Record<string, unknown>;
    }
    return {};
  }

  private getExecCommand(params: ApprovalParams): string[] {
    const command = params.command;
    if (Array.isArray(command)) {
      return command.filter((part): part is string => typeof part === 'string');
    }
    const parsedCmd = params.parsedCmd;
    if (Array.isArray(parsedCmd)) {
      return parsedCmd.map(String);
    }
    const snakeParsedCmd = params.parsed_cmd;
    if (Array.isArray(snakeParsedCmd)) {
      return snakeParsedCmd.map(String);
    }
    return [];
  }

  private getExecCwd(params: ApprovalParams): string {
    if (typeof params.cwd === 'string') {
      return params.cwd;
    }
    return '';
  }

  // ─── Public Accessors ───────────────────────────────────────

  /** Get the current conversation/session ID */
  getConversationId(): string | null {
    return this.conversationId;
  }

  /** Get the Codex session ID (may differ from conversationId after session_configured) */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Check if the backend is alive */
  get isAlive(): boolean {
    return !this.disposed && this.peer.isAlive;
  }

  /** Get the process PID */
  get pid(): number | undefined {
    return this.peer.pid;
  }
}
