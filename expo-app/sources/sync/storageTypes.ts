import { z } from "zod";
import { PERMISSION_MODES } from "@/constants/PermissionModes";
import type { PermissionMode } from "@/constants/PermissionModes";

//
// Agent states
//

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    profileId: z.string().nullable().optional(), // Session-scoped profile identity (non-secret)
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexSessionId: z.string().optional(), // Codex session/conversation ID (uuid)
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    hostPid: z.number().optional(), // Process ID of the session
    terminal: z.object({
        mode: z.enum(['plain', 'tmux']),
        requested: z.enum(['plain', 'tmux']).optional(),
        fallbackReason: z.string().optional(),
        tmux: z.object({
            target: z.string(),
            tmpDir: z.string().optional(),
        }).optional(),
    }).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    // Published by happy-cli so the app can seed permission state even before there are messages.
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    permissionModeUpdatedAt: z.number().optional(),
    messageQueueV1: z.object({
        v: z.literal(1),
        queue: z.array(z.object({
            localId: z.string(),
            message: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
        })),
        inFlight: z.object({
            localId: z.string(),
            message: z.string(),
            createdAt: z.number(),
            updatedAt: z.number(),
            claimedAt: z.number(),
        }).nullable().optional(),
    }).optional(),
    messageQueueV1Discarded: z.array(z.object({
        localId: z.string(),
        message: z.string(),
        createdAt: z.number(),
        updatedAt: z.number(),
        discardedAt: z.number(),
        discardedReason: z.enum(['switch_to_local', 'manual']),
    })).optional(),
    /**
     * Local-only markers for committed transcript messages that should be treated as discarded
     * (e.g. when the user switches to terminal control and abandons unprocessed remote messages).
     */
    discardedCommittedMessageLocalIds: z.array(z.string()).optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
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
    optimisticThinkingAt?: number | null; // Local-only timestamp used for immediate "processing" UI feedback after submit
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: PermissionMode | null; // Local permission mode, not synced to server
    permissionModeUpdatedAt?: number | null; // Local timestamp to coordinate inferred (from last message) vs user-selected mode, not synced to server
    modelMode?: 'default' | 'gemini-2.5-pro' | 'gemini-2.5-flash' | 'gemini-2.5-flash-lite' | null; // Local model mode, not synced to server
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

export interface PendingMessage {
    id: string;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
    text: string;
    displayText?: string;
    rawRecord: any;
}

export interface DiscardedPendingMessage extends PendingMessage {
    discardedAt: number;
    discardedReason: 'switch_to_local' | 'manual';
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
