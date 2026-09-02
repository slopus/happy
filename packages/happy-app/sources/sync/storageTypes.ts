import { z } from "zod";

//
// Agent states
//

export const MetadataSchema = z.object({
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
        serviceTiers: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullish(),
        })).optional(),
    })).optional(),
    currentModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    capabilities: z.object({
        regenerateTitle: z.boolean().optional(),
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    // Cursor for reconnect-safe Codex Desktop/Paws history reconciliation.
    // MetadataSchema strips unknown keys, so this must remain explicit.
    codexSyncCursor: z.object({
        threadId: z.string(),
        turnId: z.string(),
    }).optional(),
    // A full replay writes this marker before uploading deterministic envelope
    // IDs and removes it only after every batch is acknowledged.
    codexHistoryReplay: z.object({
        threadId: z.string(),
        startedAt: z.number(),
    }).optional(),
    codexPawsOriginToken: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
    skills: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(), // Process ID of the session
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    sandbox: z.any().nullish(), // Sandbox config metadata from CLI (or null when disabled)
    dangerouslySkipPermissions: z.boolean().nullish(), // Claude --dangerously-skip-permissions mode (or null when unknown)
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    /**
     * Lineage for sessions created via the fork / duplicate flow.
     * `parentSessionId` is the Happy session this one was branched from.
     * `forkedFromMessageId` is the in-app message id used as the rewind
     * point (only set for "duplicate from message", not for plain fork).
     * Both ride inside encrypted metadata so the server stays oblivious.
     */
    parentSessionId: z.string().optional(),
    forkedFromMessageId: z.string().optional(),
    /**
     * 带外图库：CLI 端 MCP take_screenshot 后写入的轻量截图引用（无字节）。
     * App 监听到 screenshotVersion 变大时，按 id 走 getScreenshotById RPC 懒拉取图片字节。
     * 注意：MetadataSchema 默认会 strip 未知字段，这两个键必须显式声明，否则解密后会被丢弃。
     */
    screenshotRefs: z.array(z.object({
        id: z.string(),
        target: z.string(),
        note: z.string().optional(),
        takenAt: z.number(),
    })).optional(),
    screenshotVersion: z.number().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    queuedMessages: z.number().int().nonnegative().optional(),
    turnStatus: z.object({
        status: z.enum(['running', 'completed', 'failed', 'cancelled']),
        updatedAt: z.number(),
        turnId: z.string().optional(),
    }).optional(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string().optional(),
});

export const TodoItemsSchema = z.array(TodoItemSchema);

export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: TodoItem[];
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: string | null; // Local permission mode key, not synced to server
    modelMode?: string | null; // Local model key, not synced to server
    effortLevel?: string | null; // Local effort level key, not synced to server
    fastMode?: boolean | null; // Local Codex Fast service tier, not synced to server
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    } | null;
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    happyHomeDir: z.string(), // Directory for Happy auth, settings, logs (usually .happy/ or .happy-dev/)
    homeDir: z.string(), // User's home directory (matches CLI field name)
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional(),
    cliAvailability: z.object({
        ask: z.boolean().optional(),
        claude: z.boolean(),
        codex: z.boolean(),
        gemini: z.boolean(),
        opencode: z.boolean().optional(),
        openclaw: z.boolean(),
        detectedAt: z.number(),
    }).optional(),
    resumeSupport: z.object({
        rpcAvailable: z.boolean(),
        requiresSameMachine: z.boolean(),
        requiresHappyAgentAuth: z.boolean(),
        happyAgentAuthenticated: z.boolean(),
        detectedAt: z.number(),
    }).optional(),
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    // Line change statistics - separated by staged vs unstaged
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    // Computed totals
    linesAdded: number;      // stagedLinesAdded + unstagedLinesAdded
    linesRemoved: number;    // stagedLinesRemoved + unstagedLinesRemoved
    linesChanged: number;    // Total lines that were modified (added + removed)
    // Branch tracking information (from porcelain v2)
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number; // Commits ahead of upstream
    behindCount?: number; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}
