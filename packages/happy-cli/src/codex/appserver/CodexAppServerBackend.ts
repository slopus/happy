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
  /** Approval policy */
  approvalPolicy?: ApprovalPolicy | null;
  /** Sandbox mode */
  sandbox?: SandboxMode | null;
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
      // Resolve any pending waitForResponseComplete() to unblock the caller
      this.resolveTurnComplete();
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
    } else {
      const newResult = await this.peer.request<NewConversationResponse>(
        Methods.NEW_CONVERSATION,
        this.buildConversationParams()
      );
      convId = newResult.conversationId;
      logger.info(`[CodexBackend] New conversation: id=${convId}, model=${newResult.model}`);
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('waitForResponseComplete timed out')), timeoutMs);
    });

    try {
      await Promise.race([this.turnCompletePromise!, timeout]);
    } finally {
      clearTimeout(timer);
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
    this.turnCompleteResolve?.();

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

    // MCP servers config
    if (this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0) {
      params.config = { mcp_servers: this.options.mcpServers };
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
    this.turnCompletePromise = new Promise<void>((resolve) => {
      this.turnCompleteResolve = resolve;
    });
  }

  private resolveTurnComplete(): void {
    this.turnCompleteResolve?.();
    this.turnCompleteResolve = null;
    this.turnCompletePromise = null;
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
    if (p?.sessionId) {
      this.sessionId = p.sessionId as string;
    }
    logger.debug(`[CodexBackend] Session configured: model=${p?.model}, sessionId=${p?.sessionId}`);
  }

  // ─── Event Mapping ──────────────────────────────────────────

  private handleCodexEvent(raw: RawCodexEvent): void {
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
      case 'stream_error':
      case 'error':
        this.emit({ type: 'status', status: 'error', detail: event.message });
        break;

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
    const callId = params.callId;

    if (this.options.permissionHandler) {
      // Store pending approval for respondToPermission()
      this.pendingApprovals.set(callId, { jsonRpcId, callId });

      // Delegate to permission handler
      this.options.permissionHandler
        .handleToolCall(callId, 'CodexPatch', {
          changes: params.fileChanges,
          reason: params.reason,
        })
        .then((result) => {
          // If still pending (not already responded via respondToPermission)
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            const decision = this.mapDecision(result.decision);
            this.peer.respond(jsonRpcId, { decision });

            // Queue feedback for denied/abort with reason
            if ((decision === 'denied' || decision === 'abort') && params.reason) {
              this.feedbackQueue.push(params.reason);
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
    const callId = params.callId;

    if (this.options.permissionHandler) {
      this.pendingApprovals.set(callId, { jsonRpcId, callId });

      this.options.permissionHandler
        .handleToolCall(callId, 'CodexBash', {
          command: params.command,
          cwd: params.cwd,
          reason: params.reason,
        })
        .then((result) => {
          if (this.pendingApprovals.has(callId)) {
            this.pendingApprovals.delete(callId);
            const decision = this.mapDecision(result.decision);
            this.peer.respond(jsonRpcId, { decision });

            // Queue feedback for denied/abort with reason
            if ((decision === 'denied' || decision === 'abort') && params.reason) {
              this.feedbackQueue.push(params.reason);
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
