import { z } from "zod";
import { MotionWorkbenchChangeSchema, MotionProjectLinkSchema, PortableContextDescriptorSchema, PortableContextBoundarySchema } from '@slopus/happy-wire';
import { messageOptionResponseSchema } from './messageOptionResponses';
import { ApplicationSessionMetadataSchema, GoalBoardBindingSchema, GoalBoardSnapshotSchema, ARTIFACT_PROTOCOL, asyncQuestionResponseSchema, DelegationRoleV1Schema, DelegatedTaskSummaryV1Schema, DelegationSnapshotV2Schema } from "@slopus/happy-wire";

//
// Agent states
//

// Metadata is also an encrypted read-modify-write envelope. Preserve fields
// introduced by newer workers while still validating every known field.
export const MetadataSchema = z.object({
    delegationProtocol: z.literal(1).optional(),
    delegationRoles: z.array(DelegationRoleV1Schema).max(100).optional(),
    delegatedTasks: z.array(DelegatedTaskSummaryV1Schema).max(100).optional(),
    delegationV2: DelegationSnapshotV2Schema.optional(),
    application: ApplicationSessionMetadataSchema.optional(),
    goalBoard: GoalBoardBindingSchema.optional(),
    goalBoardSnapshot: GoalBoardSnapshotSchema.optional(),
    motionWorkbenchChanges: z.array(MotionWorkbenchChangeSchema).max(2).optional(),
    motionProjectLinks: z.array(MotionProjectLinkSchema).max(20).optional(),
    codexAsyncQuestionResponses: z.record(z.string(), asyncQuestionResponseSchema).optional(),
    messageOptionResponses: z.record(z.string(), messageOptionResponseSchema).optional(),
    goalBoardTaskSessions: z.record(z.string().max(65536), z.string().max(256)).optional(),
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        supportedEffortLevels: z.array(z.string()).optional(),
        description: z.string().nullish(),
        serviceTiers: z.array(z.object({
            id: z.string(),
            name: z.string(),
            description: z.string().nullish(),
        })).optional(),
    })).optional(),
    currentModelCode: z.string().optional(),
    modelsUpdatedAt: z.number().finite().positive().optional(),
    codexMagpieConnection: z.boolean().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    acpPermissionMode: z.enum(['default', 'bypassPermissions']).optional(),
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
    lastUserMessageAt: z.number().finite().positive().optional(), // Encrypted, monotonic user-send clock.
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    capabilities: z.object({
        delegation: z.literal(1).optional(),
        delegationRoutes: z.literal(1).optional(),
        acpPermissionPolicy: z.boolean().optional(),
        regenerateTitle: z.boolean().optional(),
        codexCredentialRecovery: z.boolean().optional(),
        codexSteer: z.boolean().optional(),
        codexAsyncQuestions: z.boolean().optional(),
        codexModelCatalogRefresh: z.boolean().optional(),
        claudeModelCatalogRefresh: z.boolean().optional(),
        composerPrediction: z.boolean().optional(),
        artifactLeases: z.union([z.literal(1),z.literal(ARTIFACT_PROTOCOL)]).optional(),
    }).passthrough().optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    codexAccountProfileId: z.string().uuid().optional(),
    codexAccountCredentialVersion: z.number().int().positive().optional(),
    // Cursor for reconnect-safe Codex Desktop/Paws history reconciliation.
    // Keep this explicit so callers validate and type the reconnect cursor.
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
    // Restoring an auto-archived application keeps this completed turn visible;
    // the next completed turn is archived again. Never controls the processor.
    applicationArchiveRestoredThrough: z.object({
        updatedAt: z.number(),
        turnId: z.string().optional(),
    }).optional(),
    /**
     * Lineage for sessions created via the fork / duplicate flow.
     * `parentSessionId` is the Happy session this one was branched from.
     * `forkedFromMessageId` is the in-app message id used as the rewind
     * point (only set for "duplicate from message", not for plain fork).
     * Both ride inside encrypted metadata so the server stays oblivious.
     */
    continuationOfSessionId: z.string().optional(),
    continuationContext: z.string().optional(),
    portableContextProtocol: z.literal(1).optional(),
    portableContext: PortableContextDescriptorSchema.optional(),
    portableContextBoundary: PortableContextBoundarySchema.optional(),
    continuedBySessionId: z.string().optional(),
    /** Logical chat membership; ordinary continuation/fork sessions remain independent. */
    conversationRootSessionId: z.string().min(1).optional(),
    /** Authoritative execution session, stored only on the logical root. */
    conversationActiveSessionId: z.string().min(1).optional(),
    conversationSwitch: z.object({
        id: z.string().min(1),
        sourceSessionId: z.string().min(1),
        targetSessionId: z.string().min(1).optional(),
    }).optional(),
    /** A verified deletion plan survives partial failure without guessing at missing history. */
    conversationDeletePlan: z.object({
        sessionIds: z.array(z.string().min(1)).min(1).max(1000),
        completedSessionIds: z.array(z.string().min(1)).max(1000),
        activeSessionId: z.string().min(1),
    }).optional(),
    crossAgentRequestId: z.string().optional(),
    crossAgentSourceAgent: z.enum(['claude', 'codex']).optional(),
    parentSessionId: z.string().optional(),
    forkedFromMessageId: z.string().optional(),
}).passthrough();

export type Metadata = z.infer<typeof MetadataSchema>;

const AcpPermissionOptionSchema = z.object({
    id: z.string(), name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

export const AgentStateSchema = z.object({
    claudeThinking: z.boolean().optional(),
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
        createdAt: z.number().nullish(),
        permissionOptions: z.array(AcpPermissionOptionSchema).optional(),
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
        permissionOptions: z.array(AcpPermissionOptionSchema).optional(),
        optionId: z.string().optional(),
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
    lastMessageAt?: number | null, // Latest durable message; presence/metadata never advance it.
    lastUserMessageAt?: number | null, // Navigation only; never advanced by Agent output.
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
    hasPendingLocalMessages?: boolean; // Local staging queue / unconfirmed submission, not synced to server
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
    delegation: z.literal(1).optional(),
    delegationRoles: z.literal(1).optional(),
    scheduledTasks: z.literal(1).optional(),
    projectCanvas: z.object({ version: z.number().int().positive(), daemonStartedAt: z.number().int().positive() }).optional(),
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
    crossAgentContinuation: z.literal(1).optional(),
    magpieModelCatalog: z.literal(1).optional(),
    cliAvailability: z.object({
        ask: z.boolean().optional(),
        claude: z.boolean(),
        codex: z.boolean(),
        gemini: z.boolean(),
        opencode: z.boolean().optional(),
        antigravity: z.boolean().optional(),
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
