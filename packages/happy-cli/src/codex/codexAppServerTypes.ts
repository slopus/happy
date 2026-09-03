/**
 * Compatibility subset for the Codex app-server versions supported by Paws
 * (Codex 0.107.0 through 0.144.5). This is intentionally not a complete
 * generated protocol surface.
 */

export type ThreadId = string;

// --- Initialize ---

export type McpUiClientCapability = {
    mimeTypes: Array<'text/html;profile=mcp-app'>;
};

export type InitializeParams = {
    clientInfo: { name: string; title: string | null; version: string };
    capabilities: {
        experimentalApi: boolean;
        optOutNotificationMethods?: string[] | null;
        extensions?: { 'io.modelcontextprotocol/ui': McpUiClientCapability };
    } | null;
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

export type McpToolCallAppContext = {
    resourceUri?: string | null;
    resource_uri?: string | null;
    templateId?: string | null;
    appName?: string | null;
    actionName?: string | null;
    connectorId?: string | null;
    [key: string]: unknown;
};

export type McpToolCallResult = {
    content?: unknown[];
    structuredContent?: unknown;
    _meta?: unknown;
    [key: string]: unknown;
};

export type McpToolCallItem = {
    type: 'mcpToolCall';
    id: string;
    server: string;
    tool: string;
    status?: string;
    arguments?: unknown;
    result?: McpToolCallResult | null;
    error?: unknown;
    durationMs?: number | null;
    appContext?: McpToolCallAppContext | null;
    mcpAppResourceUri?: string | null;
    readOnlyHint?: boolean | null;
    [key: string]: unknown;
};

export type ThreadItem =
    | { type: "userMessage"; id: string; content: InputItem[] }
    | { type: "agentMessage"; id: string; text: string; phase?: string | null; memoryCitation?: unknown | null }
    | { type: "reasoning"; id: string; summary?: string[]; content?: string[] }
    | { type: "commandExecution"; id: string; command: string; cwd?: string; status?: string; aggregatedOutput?: string | null; exitCode?: number | null; durationMs?: number | null }
    | { type: "fileChange"; id: string; changes: unknown[]; status?: string }
    | McpToolCallItem
    | ({ type: string; id: string } & Record<string, unknown>);

export type ThreadTurn = {
    id: string;
    items: ThreadItem[];
    itemsView?: unknown;
    status?: unknown;
    error?: unknown;
    startedAt?: number | null;
    completedAt?: number | null;
    durationMs?: number | null;
};

export type Thread = {
    id: ThreadId;
    forkedFromId?: string | null;
    path?: string | null;
    cwd?: string;
    turns?: ThreadTurn[];
    [key: string]: unknown;
};

export type ForkConversationParams = {
    threadId: ThreadId;
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
    approvalPolicy?: ApprovalPolicy | null;
    sandbox?: SandboxMode | null;
    config?: Record<string, unknown> | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    ephemeral?: boolean;
    threadSource?: unknown | null;
};

export type ForkConversationResponse = {
    thread: Thread;
    model: string;
    modelProvider?: string;
    cwd?: string;
    approvalPolicy?: ApprovalPolicy;
    sandbox?: unknown;
    reasoningEffort?: ReasoningEffort | null;
};

export type ReadConversationParams = {
    threadId: ThreadId;
    includeTurns: boolean;
};

export type ReadConversationResponse = {
    thread: Thread;
};

export type ThreadListParams = {
    cursor?: string | null;
    limit?: number | null;
    sortKey?: "created_at" | "updated_at" | "recency_at" | null;
    sortDirection?: "asc" | "desc" | null;
    modelProviders?: string[] | null;
    sourceKinds?: Array<"cli" | "vscode" | "exec" | "appServer" | "subAgent" | "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown"> | null;
    archived?: boolean | null;
    cwd?: string | string[] | null;
    useStateDbOnly?: boolean;
    searchTerm?: string | null;
};

export type ListedThread = Thread & {
    sessionId?: string;
    parentThreadId?: string | null;
    preview?: string;
    ephemeral?: boolean;
    createdAt?: number;
    updatedAt?: number;
    recencyAt?: number | null;
    source?: "cli" | "vscode" | "exec" | "appServer" | { custom: string } | { subAgent: unknown } | "unknown";
    name?: string | null;
    archived?: boolean;
};

export type ThreadListResponse = {
    data: ListedThread[];
    nextCursor: string | null;
    backwardsCursor?: string | null;
};

export type RollbackConversationParams = {
    threadId: ThreadId;
    numTurns: number;
};

export type RollbackConversationResponse = {
    thread: Thread;
};

export type InjectItemsParams = {
    threadId: ThreadId;
    items: unknown[];
};

export type InjectItemsResponse = Record<string, never>;

// --- MCP resources ---

export type McpResourceReadParams = {
    threadId: string;
    server: string;
    uri: string;
    originCallId?: string;
    connectorId?: string;
};

export type McpResourceReadResponse = {
    contents: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        _meta?: unknown;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
};

export type ModelListParams = {
    cursor?: string | null;
    includeHidden?: boolean | null;
    limit?: number | null;
};

export type ReasoningEffortOption = {
    reasoningEffort: ReasoningEffort;
    description: string;
};

export type Model = {
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    supportedReasoningEfforts: ReasoningEffortOption[];
    defaultReasoningEffort: ReasoningEffort;
    isDefault: boolean;
    serviceTiers?: Array<{ id: string; name: string; description?: string | null }>;
    service_tiers?: Array<{ id: string; name: string; description?: string | null }>;
};

export type ModelListResponse = {
    data: Model[];
    nextCursor?: string | null;
};

export type ThreadSettings = {
    model: string;
    effort?: ReasoningEffort | null;
};

export type ThreadSettingsUpdatedNotification = {
    threadId: ThreadId;
    threadSettings: ThreadSettings;
};

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoal = {
    threadId: string;
    objective: string;
    status: ThreadGoalStatus;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: number;
    updatedAt: number;
};

export type ThreadGoalSetParams = {
    threadId: ThreadId;
    objective?: string | null;
    status?: ThreadGoalStatus | null;
    tokenBudget?: number | null;
};

export type ThreadGoalSetResponse = {
    goal: ThreadGoal;
};

export type ThreadGoalGetParams = {
    threadId: ThreadId;
};

export type ThreadGoalGetResponse = {
    goal: ThreadGoal | null;
};

export type ThreadGoalClearParams = {
    threadId: ThreadId;
};

export type ThreadGoalClearResponse = {
    cleared: boolean;
};

// --- Mobile slash command helpers ---

export type AccountTokenUsageDailyBucket = {
    startDate: string;
    tokens: number;
};

export type AccountTokenUsageSummary = {
    currentStreakDays?: number | null;
    lifetimeTokens?: number | null;
    longestRunningTurnSec?: number | null;
    longestStreakDays?: number | null;
    peakDailyTokens?: number | null;
};

export type GetAccountTokenUsageResponse = {
    summary: AccountTokenUsageSummary;
    dailyUsageBuckets?: AccountTokenUsageDailyBucket[] | null;
};

export type McpServerStatusDetail = "full" | "toolsAndAuthOnly";

export type McpToolAnnotations = {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
};

export type McpToolCatalogEntry = {
    name: string;
    enabled?: boolean;
    description?: string | null;
    title?: string | null;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: McpToolAnnotations;
    _meta?: {
        ui?: { visibility?: string[]; [key: string]: unknown };
        'ui/visibility'?: string[];
        connectorId?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

export type McpToolDefinition = McpToolCatalogEntry;

export type McpServerStatus = {
    name: string;
    authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
    runtimeStatus?: "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled" | null;
    pluginId?: string | null;
    tools: Record<string, McpToolCatalogEntry> | McpToolCatalogEntry[];
    resources?: unknown[];
    resourceTemplates?: unknown[];
    serverInfo?: {
        name: string;
        title?: string | null;
        version: string;
        description?: string | null;
        websiteUrl?: string | null;
    } | null;
};

export type ListMcpServerStatusParams = {
    threadId?: ThreadId | null;
    detail?: McpServerStatusDetail | null;
    cursor?: string | null;
    limit?: number | null;
};

export type ListMcpServerStatusResponse = {
    data: McpServerStatus[];
    nextCursor?: string | null;
};

export type McpServerToolCallParams = {
    threadId: string;
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
    /** Additive Paws/Codex provenance binding for App-initiated calls. */
    originCallId: string;
};

export type McpServerToolCallResponse = {
    content: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
    _meta?: unknown;
    [key: string]: unknown;
};

export type ThreadCompactStartResponse = Record<string, never>;

export type ReviewStartParams = {
    threadId: ThreadId;
    delivery?: "inline" | "detached";
    target:
        | { type: "uncommittedChanges" }
        | { type: "custom"; instructions: string };
};

export type ReviewStartResponse = {
    turn?: ThreadTurn;
    reviewThreadId: ThreadId;
};

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
