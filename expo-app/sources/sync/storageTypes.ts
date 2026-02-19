import { z } from "zod";

//
// Agent states
//

export interface Metadata {
    path: string;
    host: string;
    version?: string;
    name?: string;
    os?: string;
    summary?: {
        text: string;
        updatedAt: number;
    };
    machineId?: string;
    claudeSessionId?: string; // Claude Code session ID
    tools?: string[];
    slashCommands?: string[];
    homeDir?: string; // User's home directory on the machine
    happyHomeDir?: string; // Happy configuration directory 
    hostPid?: number; // Process ID of the session
    flavor?: string | null; // Session flavor/variant identifier
    // Channel / conversation metadata (OpenClaw and other channel integrations)
    channel?: string;
    channelId?: string;
    channelName?: string;
    channelType?: string;
    channelProvider?: string;
    conversationId?: string;
    conversationName?: string;
    threadId?: string;
    threadName?: string;
    groupId?: string;
    groupName?: string;
    roomId?: string;
    roomName?: string;
    chatId?: string;
    chatName?: string;
    jid?: string;
    userId?: string;
    userName?: string;
    title?: string;
    provider?: string;
    platform?: string;
    source?: string;
}

const ChannelIdSchema = z.union([z.string(), z.number()]);
const ChannelSchema = z.union([z.string(), z.number(), z.record(z.any())]);

const RawMetadataSchema = z.object({
    path: z.string().optional(),
    host: z.string().optional(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    happyHomeDir: z.string().optional(), // Happy configuration directory 
    hostPid: z.number().optional(), // Process ID of the session
    flavor: z.string().nullish(), // Session flavor/variant identifier
    // Channel / conversation metadata (OpenClaw and other channel integrations)
    channel: ChannelSchema.optional(),
    channelId: ChannelIdSchema.optional(),
    channelName: z.string().optional(),
    channelType: z.string().optional(),
    channelProvider: z.string().optional(),
    conversationId: ChannelIdSchema.optional(),
    conversationName: z.string().optional(),
    threadId: ChannelIdSchema.optional(),
    threadName: z.string().optional(),
    groupId: ChannelIdSchema.optional(),
    groupName: z.string().optional(),
    roomId: ChannelIdSchema.optional(),
    roomName: z.string().optional(),
    chatId: ChannelIdSchema.optional(),
    chatName: z.string().optional(),
    jid: ChannelIdSchema.optional(),
    userId: ChannelIdSchema.optional(),
    userName: z.string().optional(),
    title: z.string().optional(),
    provider: z.string().optional(),
    platform: z.string().optional(),
    source: z.string().optional(),
}).passthrough();

type RawMetadata = z.infer<typeof RawMetadataSchema>;

const normalizeMetadataString = (value: unknown): string | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
};

const pickFirstString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const key of keys) {
        const value = normalizeMetadataString(record[key]);
        if (value) {
            return value;
        }
    }
    return undefined;
};

const normalizeMetadata = (data: RawMetadata): Metadata => {
    const record = data as Record<string, unknown>;
    const explicitPath = normalizeMetadataString(data.path);
    const explicitHost = normalizeMetadataString(data.host);
    const channelRecord = asRecord(record.channel);

    const channelProvider = normalizeMetadataString(data.channelProvider)
        ?? pickFirstString(record, ['channel_provider', 'provider', 'platform', 'source', 'service', 'network'])
        ?? (channelRecord ? pickFirstString(channelRecord, ['provider', 'platform', 'source', 'service', 'network']) : undefined);
    const channelType = normalizeMetadataString(data.channelType)
        ?? pickFirstString(record, ['channel_type'])
        ?? (channelRecord ? pickFirstString(channelRecord, ['type', 'channelType', 'channel_type']) : undefined);
    const channel = normalizeMetadataString(data.channel)
        ?? channelProvider
        ?? pickFirstString(record, ['channel', 'provider', 'platform', 'source', 'service', 'network', 'channelType', 'channelProvider', 'channel_type', 'channel_provider']);
    const channelId = normalizeMetadataString(data.channelId)
        ?? pickFirstString(record, [
            'channel_id',
            'conversationId',
            'conversation_id',
            'threadId',
            'thread_id',
            'roomId',
            'room_id',
            'groupId',
            'group_id',
            'chatId',
            'chat_id',
            'jid',
            'chat_jid',
            'contactId',
            'contact_id',
            'userId',
            'user_id'
        ])
        ?? (channelRecord ? pickFirstString(channelRecord, [
            'id',
            'channelId',
            'channel_id',
            'conversationId',
            'conversation_id',
            'threadId',
            'thread_id',
            'roomId',
            'room_id',
            'groupId',
            'group_id',
            'chatId',
            'chat_id',
            'jid',
            'chat_jid',
            'contactId',
            'contact_id',
            'userId',
            'user_id'
        ]) : undefined);
    const channelName = normalizeMetadataString(data.channelName)
        ?? pickFirstString(record, [
            'channel_name',
            'conversationName',
            'conversation_name',
            'threadName',
            'thread_name',
            'roomName',
            'room_name',
            'groupName',
            'group_name',
            'chatName',
            'chat_name',
            'name',
            'title',
            'contactName',
            'contact_name',
            'userName',
            'user_name',
            'displayName',
            'display_name'
        ])
        ?? (channelRecord ? pickFirstString(channelRecord, [
            'name',
            'channelName',
            'channel_name',
            'conversationName',
            'conversation_name',
            'threadName',
            'thread_name',
            'roomName',
            'room_name',
            'groupName',
            'group_name',
            'chatName',
            'chat_name',
            'title',
            'displayName',
            'display_name'
        ]) : undefined);

    const host = explicitHost
        ?? channel
        ?? channelProvider
        ?? normalizeMetadataString(data.provider)
        ?? normalizeMetadataString(data.platform)
        ?? normalizeMetadataString(data.source)
        ?? '';
    const path = explicitPath ?? channelId ?? channelName ?? '';

    return {
        ...data,
        host,
        path,
        channel,
        channelId,
        channelName,
        channelProvider,
        channelType,
    };
};

export const MetadataSchema: z.ZodType<Metadata> = RawMetadataSchema.transform((data) => normalizeMetadata(data));

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
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo' | null; // Local permission mode, not synced to server
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
