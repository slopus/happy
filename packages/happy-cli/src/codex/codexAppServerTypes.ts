/**
 * Cherry-picked types from `codex app-server generate-ts` (Codex 0.107.0).
 * Only the essential types needed for our integration.
 */

export type ThreadId = string;

// --- Initialize ---

export type InitializeParams = {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: { experimentalApi: boolean; optOutNotificationMethods?: string[] | null } | null;
};

export type InitializeResponse = { userAgent: string };

// --- Thread lifecycle ---

export type NewConversationParams = {
    model: string | null;
    modelProvider: string | null;
    profile: string | null;
    cwd: string | null;
    approvalPolicy: ApprovalPolicy | null;
    sandbox: SandboxMode | null;
    config: Record<string, unknown> | null;
    baseInstructions: string | null;
    developerInstructions: string | null;
    compactPrompt: string | null;
    includeApplyPatchTool: boolean | null;
    experimentalRawEvents: boolean;
    persistExtendedHistory: boolean;
};

export type NewConversationResponse = {
    thread: {
        id: ThreadId;
        path: string;
        [key: string]: unknown;
    };
    model: string;
    modelProvider: string;
    cwd: string;
    approvalPolicy: ApprovalPolicy;
    sandbox: unknown;
    reasoningEffort: ReasoningEffort | null;
};

export type ResumeConversationParams = {
    threadId: ThreadId;
    model: string | null;
    modelProvider: string | null;
    cwd: string | null;
    approvalPolicy: ApprovalPolicy | null;
    sandbox: SandboxMode | null;
    config: Record<string, unknown> | null;
    baseInstructions: string | null;
    developerInstructions: string | null;
    persistExtendedHistory: boolean;
};

export type ResumeConversationResponse = NewConversationResponse;

// --- Turn lifecycle ---

export type SendUserTurnParams = {
    threadId: ThreadId;
    input: InputItem[];
    cwd: string;
    approvalPolicy: ApprovalPolicy;
    sandboxPolicy: SandboxPolicy;
    model: string;
    effort: ReasoningEffort | null;
    summary: ReasoningSummary;
    outputSchema: unknown | null;
};

export type InterruptConversationParams = {
    threadId: ThreadId;
    turnId: string;
};

export type InterruptConversationResponse = {
    abortReason: TurnAbortReason;
};

// --- Approvals (server → client requests) ---

export type ExecCommandApprovalParams = {
    conversationId: ThreadId;
    callId: string;
    approvalId: string | null;
    command: string[];
    cwd: string;
    reason: string | null;
    parsedCmd: unknown[];
};

export type ApplyPatchApprovalParams = {
    conversationId: ThreadId;
    callId: string;
    fileChanges: Record<string, FileChange>;
    reason: string | null;
    grantRoot: string | null;
};

export type ApprovalResponse = {
    decision: ReviewDecision;
};

export type McpServerElicitationAction = "accept" | "decline" | "cancel";

export type McpServerElicitationRequestResponse = {
    action: McpServerElicitationAction;
    content: Record<string, unknown> | null;
    _meta: Record<string, unknown> | null;
};

export type ReviewDecision =
    | "approved"
    | { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } }
    | "approved_for_session"
    | "denied"
    | "abort";

// --- Shared enums ---

export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type TurnAbortReason = "interrupted" | "replaced" | "review_ended";

export type InputItem =
    | { type: "text"; text: string; text_elements?: unknown[] }
    | { type: "image"; url: string }
    | { type: "localImage"; path: string };

export type SandboxPolicy =
    | { type: "dangerFullAccess" }
    | { type: "readOnly" }
    | { type: "externalSandbox"; networkAccess: boolean }
    | {
          type: "workspaceWrite";
          writableRoots?: string[];
          networkAccess: boolean;
          excludeTmpdirEnvVar: boolean;
          excludeSlashTmp: boolean;
      };

export type FileChange =
    | { type: "add"; content: string }
    | { type: "delete"; content: string }
    | { type: "update"; unified_diff: string; move_path: string | null };

// --- Events ---
// Events arrive as `codex/event` notifications with `{ msg: EventMsg }`.
// EventMsg uses the same type discriminators as the MCP server, so our
// existing handler works without changes. We type it loosely here.
export type EventMsg = { type: string } & Record<string, unknown>;

// --- JSON-RPC 2.0 wire types ---

export type JsonRpcRequest = {
    jsonrpc?: "2.0";
    id?: number;
    method: string;
    params?: unknown;
};

export type JsonRpcResponse = {
    jsonrpc?: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
};
