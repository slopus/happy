/**
 * Codex App-Server JSON-RPC Protocol Types (V1)
 *
 * Type definitions for the Codex CLI app-server mode, which uses
 * a non-standard JSON-RPC protocol over stdin/stdout (no "jsonrpc" field).
 *
 * References:
 * - codex-rs/app-server-protocol at rust-v0.98.0
 * - vibe-kanban/crates/executors/src/executors/codex/
 */

// ─── Wire Format ───────────────────────────────────────────────

export type RequestId = string | number;

/** Client-to-server or server-to-client request */
export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

/** Notification (no id, no response expected) */
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

/** Server response (has id + result) */
export interface JsonRpcResponse {
  id: RequestId;
  result: unknown;
}

/** Server error response (has id + error) */
export interface JsonRpcErrorResponse {
  id: RequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** Union of all possible wire messages */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

// ─── Initialize ────────────────────────────────────────────────

export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string | null;
    version: string;
  };
  capabilities?: unknown | null;
}

export interface InitializeResponse {
  userAgent: string;
}

// ─── Conversation Management ───────────────────────────────────

export interface NewConversationParams {
  model?: string | null;
  modelProvider?: string | null;
  profile?: string | null;
  cwd?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  compactPrompt?: string | null;
  includeApplyPatchTool?: boolean | null;
}

export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface NewConversationResponse {
  conversationId: string;
  model: string;
  reasoningEffort?: string | null;
  rolloutPath: string;
}

export interface ResumeConversationParams {
  path?: string | null;
  conversationId?: string | null;
  history?: unknown[] | null;
  overrides?: NewConversationParams | null;
}

export interface ResumeConversationResponse {
  conversationId: string;
  model: string;
  reasoningEffort?: string | null;
  initialMessages?: EventMsg[] | null;
  rolloutPath: string;
}

export interface AddConversationListenerParams {
  conversationId: string;
  experimentalRawEvents?: boolean;
}

export interface AddConversationListenerResponse {
  subscriptionId: string;
}

// ─── User Messages ─────────────────────────────────────────────

export interface SendUserMessageParams {
  conversationId: string;
  items: InputItem[];
}

export type InputItem =
  | { type: 'text'; data: { text: string; textElements?: unknown[] } }
  | { type: 'image'; data: { image_url: string } }
  | { type: 'localImage'; data: { path: string } };

export interface SendUserMessageResponse {}

// ─── Interrupt ─────────────────────────────────────────────────

export interface InterruptConversationParams {
  conversationId: string;
}

// ─── Auth ──────────────────────────────────────────────────────

export interface GetAuthStatusParams {
  includeToken?: boolean | null;
  refreshToken?: boolean | null;
}

export interface GetAuthStatusResponse {
  authMethod?: 'apiKey' | 'chatgpt' | 'chatgptAuthTokens' | null;
  authToken?: string | null;
  requiresOpenaiAuth?: boolean | null;
}

// ─── Approval Requests (server → client) ───────────────────────

export type ReviewDecision =
  | 'approved'
  | 'approved_for_session'
  | 'denied'
  | 'abort';

export interface ApplyPatchApprovalParams {
  conversationId: string;
  callId: string;
  fileChanges: Record<string, FileChange>;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface ApplyPatchApprovalResponse {
  decision: ReviewDecision;
}

export interface ExecCommandApprovalParams {
  conversationId: string;
  callId: string;
  command: string[];
  cwd: string;
  reason?: string | null;
  parsedCmd?: ParsedCommand[];
}

export interface ExecCommandApprovalResponse {
  decision: ReviewDecision;
}

export interface ParsedCommand {
  [key: string]: unknown;
}

export interface FileChange {
  [key: string]: unknown;
}

// ─── Event Notifications ───────────────────────────────────────

/** Union of all Codex event types, discriminated by `type` field */
export type EventMsg =
  | { type: 'agent_message_delta'; delta: string }
  | { type: 'agent_message_content_delta'; delta: string; item_id: string; thread_id?: string; turn_id?: string }
  | { type: 'agent_message'; message: string }
  | { type: 'agent_reasoning_delta'; delta: string }
  | { type: 'reasoning_content_delta'; delta: string; item_id: string; summary_index?: number; thread_id?: string; turn_id?: string }
  | { type: 'agent_reasoning'; text: string }
  | { type: 'agent_reasoning_section_break'; item_id: string; summary_index: number }
  | { type: 'exec_approval_request'; call_id: string; turn_id?: string; command: string[]; cwd: string; reason?: string; parsed_cmd?: ParsedCommand[] }
  | { type: 'apply_patch_approval_request'; call_id: string; turn_id?: string; changes: Record<string, FileChange>; reason?: string; grant_root?: string }
  | { type: 'exec_command_begin'; call_id: string; process_id?: string; turn_id?: string; command: string[]; cwd: string; parsed_cmd?: ParsedCommand[]; source?: string; interaction_input?: string }
  | { type: 'exec_command_output_delta'; call_id: string; stream: 'stdout' | 'stderr'; chunk: number[] }
  | { type: 'exec_command_end'; call_id: string; process_id?: string; turn_id?: string; command: string[]; cwd: string; stdout: string; stderr: string; aggregated_output?: string; exit_code: number; duration?: unknown; formatted_output?: string }
  | { type: 'patch_apply_begin'; call_id: string; turn_id?: string; auto_approved: boolean; changes: Record<string, FileChange> }
  | { type: 'patch_apply_end'; call_id: string; turn_id?: string; stdout: string; stderr: string; success: boolean; changes?: Record<string, FileChange> }
  | { type: 'mcp_tool_call_begin'; call_id: string; invocation: { server: string; tool: string; arguments?: unknown } }
  | { type: 'mcp_tool_call_end'; call_id: string; invocation: { server: string; tool: string; arguments?: unknown }; duration?: unknown; result: unknown }
  | { type: 'web_search_begin'; call_id: string }
  | { type: 'web_search_end'; call_id: string; query: string; action?: unknown }
  | { type: 'view_image_tool_call'; call_id: string; path: string }
  | { type: 'background_event'; message: string }
  | { type: 'stream_error'; message: string; codex_error_info?: unknown; additional_details?: string }
  | { type: 'error'; message: string; codex_error_info?: unknown }
  | { type: 'warning'; message: string }
  | { type: 'session_configured'; session_id: string; model: string; approval_policy?: string; sandbox_policy?: string; cwd?: string; reasoning_effort?: unknown; rollout_path?: string }
  | { type: 'token_count'; info?: TokenUsageInfo; rate_limits?: unknown }
  | { type: 'plan_update'; explanation?: string; plan: PlanStep[] }
  | { type: 'context_compacted'; [key: string]: unknown }
  | { type: 'task_started'; [key: string]: unknown }
  | { type: 'task_complete'; [key: string]: unknown }
  | { type: 'turn_aborted'; [key: string]: unknown }
  | { type: 'turn_diff'; unified_diff?: string; [key: string]: unknown }
  | { type: 'skills_update_available' }
  | { type: 'item_started'; item: unknown; thread_id?: string; turn_id?: string }
  | { type: 'item_completed'; item: unknown; thread_id?: string; turn_id?: string }
  | { type: 'mcp_startup_update'; server: string; status: unknown }
  | { type: 'mcp_startup_complete'; ready: string[]; failed: unknown[]; cancelled: string[] }
  | { type: 'user_message'; message: string }
  | { type: 'shutdown_complete' };

/** Raw event from Codex (may include unknown event types) */
export type RawCodexEvent = EventMsg | { type: string; [key: string]: unknown };

/** Per-request or cumulative token usage breakdown from OpenAI */
export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

/** Token usage info from Codex token_count event */
export interface TokenUsageInfo {
  total_token_usage?: TokenUsage;
  last_token_usage?: TokenUsage;
  model_context_window?: number | null;
  [key: string]: unknown;
}

export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ─── Constants ─────────────────────────────────────────────────

/** Well-known JSON-RPC method names */
export const Methods = {
  // Client → Server
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  NEW_CONVERSATION: 'newConversation',
  RESUME_CONVERSATION: 'resumeConversation',
  ADD_CONVERSATION_LISTENER: 'addConversationListener',
  SEND_USER_MESSAGE: 'sendUserMessage',
  GET_AUTH_STATUS: 'getAuthStatus',
  INTERRUPT_CONVERSATION: 'interruptConversation',

  // Server → Client (approval requests)
  APPLY_PATCH_APPROVAL: 'applyPatchApproval',
  EXEC_COMMAND_APPROVAL: 'execCommandApproval',

  // Notification prefix
  EVENT_PREFIX: 'codex/event',
} as const;
