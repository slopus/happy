import { z } from "zod";

//
// Agent states
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    // ACP session configuration metadata
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullable().optional(),
    })).optional(),
    currentModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullable().optional(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullable().optional(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    summaryPinned: z.boolean().optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexSessionId: z.string().optional(), // Codex CLI conversation ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    hostPid: z.number().optional(), // Process ID of the session
    flavor: z.string().nullish(), // Session flavor/variant identifier
    isWorktree: z.boolean().optional(), // Whether this session uses a git worktree
    worktreeBasePath: z.string().optional(), // Original repository path before worktree
    worktreeBranchName: z.string().optional(), // Branch name created for the worktree
    worktreePrUrl: z.string().optional(), // GitHub PR URL for this worktree
    reviewOfSessionId: z.string().optional(), // Links review session to the session being reviewed
    workspaceRepos: z.array(z.object({
        repoId: z.string().optional(),
        path: z.string(),
        basePath: z.string(),
        branchName: z.string(),
        targetBranch: z.string().optional(),
        prUrl: z.string().optional(),
        displayName: z.string().optional(),
    })).optional(),
    workspacePath: z.string().optional(),
    externalContext: z.object({
        source: z.string(),
        sourceUrl: z.string().optional(),
        resourceType: z.string(),
        resourceId: z.string(),
        title: z.string().optional(),
        deepLink: z.string().optional(),
        extra: z.record(z.unknown()).optional(),
    }).optional(),
    sessionIcon: z.string().optional(),
    completionDismissedAt: z.number().nullish(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    taskCompleted: z.number().nullish(),
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
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish(),
        answers: z.record(z.string(), z.string()).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export interface SessionDraft {
    text: string;
    images: Array<{ uri: string; width: number; height: number; mimeType: string }>;
}

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
    messageSyncing?: boolean,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: SessionDraft | null; // Local draft message with optional images, not synced to server
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo' | null; // Session permission mode (cached locally; source of truth is UserKV)
    modelMode?: string | null; // Session model mode (cached locally; source of truth is UserKV)
    upgrading?: boolean; // True while session is being upgraded to new CLI version
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        contextWindowSize?: number;
        timestamp: number;
    } | null;
    owner?: string;
    isShared?: boolean;
    ownerProfile?: {
        id: string;
        username: string;
        firstName: string;
        lastName: string | null;
        avatar: string | null;
    };
    accessLevel?: 'view' | 'edit' | 'admin';
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
    sentBy?: string | null,
    sentByName?: string | null,
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
    shutdownSource: z.enum(['happy-app', 'happy-cli', 'os-signal', 'unknown']).optional()
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
