/**
 * Codex App-Server JSON-RPC Protocol Types (V2 — thread/turn model)
 *
 * Type definitions for the Codex CLI app-server mode (≥ v0.112.0), which uses
 * a JSON-RPC protocol over stdin/stdout with a thread/turn lifecycle.
 *
 * References:
 * - docs/codex-app-server-0.112.0/ (generated JSON schemas)
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

// ─── Thread Management ─────────────────────────────────────────

export interface ThreadStartParams {
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxMode | null;
  serviceTier?: ServiceTier | null;
  ephemeral?: boolean | null;
}

export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ServiceTier = 'fast' | 'flex';

export interface Thread {
  id: string;
  name?: string | null;
  cwd: string;
  status: unknown;
  source: unknown;
  preview: string;
  turns: Turn[];
  createdAt: number;
  updatedAt: number;
  cliVersion: string;
  modelProvider: string;
  ephemeral: boolean;
  path?: string | null;
  gitInfo?: unknown;
  agentNickname?: string | null;
  agentRole?: string | null;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: unknown;
  reasoningEffort?: string | null;
  serviceTier?: ServiceTier | null;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  config?: Record<string, unknown> | null;
  approvalPolicy?: ApprovalPolicy | null;
  sandbox?: SandboxMode | null;
  serviceTier?: ServiceTier | null;
}

export interface ThreadResumeResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: ApprovalPolicy;
  sandbox: unknown;
  reasoningEffort?: string | null;
  serviceTier?: ServiceTier | null;
}

// ─── Turn Management ───────────────────────────────────────────

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  model?: string | null;
  approvalPolicy?: ApprovalPolicy | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null;
}

export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string };

export interface TurnStartResponse {
  turn: Turn;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  error?: TurnError | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface TurnInterruptResponse {}

// ─── ThreadItem ────────────────────────────────────────────────

/** Discriminated union of thread item types */
export type ThreadItem = { id: string; type: string; [key: string]: unknown };

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

// New v2 approval decisions (shared by command execution and file change)
export type V2ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

/** @deprecated Use V2ApprovalDecision */
export type CommandExecutionApprovalDecision = V2ApprovalDecision;
/** @deprecated Use V2ApprovalDecision */
export type FileChangeApprovalDecision = V2ApprovalDecision;

// Legacy approval decision (kept for deprecated handlers)
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

// New v2 approval requests
export interface CommandExecutionApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  command?: string | null;
  commandActions?: unknown[] | null;
  cwd?: string | null;
  reason?: string | null;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  grantRoot?: string | null;
  reason?: string | null;
}

export interface ParsedCommand {
  [key: string]: unknown;
}

export interface FileChange {
  [key: string]: unknown;
}

// ─── Token Usage ───────────────────────────────────────────────

export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

// ─── Constants ─────────────────────────────────────────────────

/** Well-known JSON-RPC method names (v2 — thread/turn model) */
export const Methods = {
  // Client → Server
  INITIALIZE: 'initialize',
  INITIALIZED: 'initialized',
  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  GET_AUTH_STATUS: 'getAuthStatus',

  // Server → Client (legacy approval requests — deprecated but still sent)
  APPLY_PATCH_APPROVAL: 'applyPatchApproval',
  EXEC_COMMAND_APPROVAL: 'execCommandApproval',

  // Server → Client (v2 approval requests)
  COMMAND_EXECUTION_APPROVAL: 'item/commandExecution/requestApproval',
  FILE_CHANGE_APPROVAL: 'item/fileChange/requestApproval',
  MCP_ELICITATION: 'mcpServer/elicitation/request',
  TOOL_CALL: 'item/tool/call',

  // Server notifications (v2)
  NOTIFY_THREAD_STARTED: 'thread/started',
  NOTIFY_THREAD_STATUS_CHANGED: 'thread/status/changed',
  NOTIFY_THREAD_CLOSED: 'thread/closed',
  NOTIFY_THREAD_TOKEN_USAGE: 'thread/tokenUsage/updated',
  NOTIFY_TURN_STARTED: 'turn/started',
  NOTIFY_TURN_COMPLETED: 'turn/completed',
  NOTIFY_TURN_DIFF: 'turn/diff/updated',
  NOTIFY_TURN_PLAN: 'turn/plan/updated',
  NOTIFY_ITEM_STARTED: 'item/started',
  NOTIFY_ITEM_COMPLETED: 'item/completed',
  NOTIFY_AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  NOTIFY_COMMAND_OUTPUT_DELTA: 'item/commandExecution/outputDelta',
  NOTIFY_FILE_CHANGE_DELTA: 'item/fileChange/outputDelta',
  NOTIFY_REASONING_DELTA: 'item/reasoning/textDelta',
  NOTIFY_REASONING_SUMMARY_DELTA: 'item/reasoning/summaryTextDelta',
  NOTIFY_REASONING_SUMMARY_ADDED: 'item/reasoning/summaryPartAdded',
  NOTIFY_PLAN_DELTA: 'item/plan/delta',
  NOTIFY_MCP_PROGRESS: 'item/mcpToolCall/progress',
  NOTIFY_ERROR: 'error',
  NOTIFY_DEPRECATION: 'deprecationNotice',
  NOTIFY_CONFIG_WARNING: 'configWarning',
} as const;
