import type { PawsAgentError } from './errors';

export type PawsCredentials = {
    token: string;
    secret: Uint8Array;
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

export interface CredentialProvider {
    getCredentials(): Promise<PawsCredentials | null>;
    setCredentials(credentials: PawsCredentials): Promise<void>;
    clearCredentials(): Promise<void>;
}

export interface AgentStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
}

export interface AgentLogger {
    debug?(message: string, details?: Record<string, unknown>): void;
    info?(message: string, details?: Record<string, unknown>): void;
    warn?(message: string, details?: Record<string, unknown>): void;
    error?(message: string, details?: Record<string, unknown>): void;
}

export type ReconnectPolicy = {
    initialDelayMs?: number;
    maxDelayMs?: number;
    attempts?: number;
};

export type ConnectionState = 'disconnected' | 'connecting' | 'syncing' | 'ready' | 'reconnecting';

export type Machine = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: unknown | null;
    metadataVersion: number;
    daemonState: unknown | null;
    daemonStateVersion: number;
};

export type BrowseDirectoryInput = {
    machineId: string;
    /** Empty or omitted starts at the remote machine's home directory. */
    path?: string;
};

export type BrowseDirectoryEntry = {
    name: string;
    path: string;
    isProjectRoot: boolean;
};

export type BrowseDirectoryResult =
    | {
        success: true;
        path: string;
        parent: string | null;
        home: string;
        directories: BrowseDirectoryEntry[];
    }
    | { success: false; error: string };

export type Session = {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: unknown | null;
    metadataVersion: number;
    agentState: unknown | null;
    agentStateVersion: number;
};

export type Message = {
    id: string;
    seq: number;
    content: unknown;
    localId: string | null;
    createdAt: number;
    updatedAt: number;
};

export type AgentRequest = {
    id: string;
    type: string;
    payload: unknown;
};

export type SupportedAgent = 'ask' | 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';

export type SpawnSessionInput = {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: SupportedAgent;
    providerToken?: string;
};

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export type ResumeSessionInput = {
    sessionId: string;
};

export type ImageAttachmentInput = {
    name: string;
    mimeType: string;
    /** 原始图片字节；SDK 在上传前加密，不依赖 DOM 或本地文件路径。 */
    bytes: Uint8Array;
    width?: number;
    height?: number;
};

/** Overrides for the next submitted turn. Omitted fields preserve runtime settings;
 * null resets to the agent default. No running turn is interrupted. */
export type TurnConfiguration = {
    model?: string | null;
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
};
export type ConfigurationOption = { code: string; label: string; description?: string };
export type SessionConfiguration = {
    model: string | null;
    effort: string | null;
    models: ConfigurationOption[];
    /** Options reported for the current model only. */
    efforts: ConfigurationOption[];
};

export type SendMessageInput = {
    sessionId: string;
    text: string;
    localId?: string;
    meta?: Record<string, unknown>;
    configuration?: TurnConfiguration;
    /** 最多四张 PNG/JPEG/WebP，每张不超过 10 MiB。 */
    images?: ImageAttachmentInput[];
    /** 取消尚未完成的上传和消息提交；已被服务器接受的消息无法撤回。 */
    signal?: AbortSignal;
};

export type SendMessageReceipt = {
    sessionId: string;
    localId: string;
};

export type ResolveRequestInput = {
    sessionId: string;
    requestId: string;
};

export interface MachinesResource {
    list(options?: { active?: boolean }): Promise<Machine[]>;
    /** Browse visible directories below the remote machine's canonical home directory. */
    browseDirectory(input: BrowseDirectoryInput): Promise<BrowseDirectoryResult>;
}

export interface SessionsResource {
    list(options?: { active?: boolean }): Promise<Session[]>;
    get(sessionId: string): Promise<Session>;
    getConfiguration(sessionId: string): Promise<SessionConfiguration>;
    spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>;
    resume(input: ResumeSessionInput): Promise<SpawnSessionResult>;
    /** End the execution process, retaining history for resume. */
    terminate(sessionId: string): Promise<void>;
    stop(sessionId: string): Promise<void>;
}

export interface MessagesResource {
    /** Latest messages by creation time by default; explicit cursors return ascending seq. */
    history(sessionId: string, options?: MessageHistoryOptions): Promise<Message[]>;
    /** Exclusive cursors. Continue forwards with the largest seq, backwards with the smallest. */
    historyPage(sessionId: string, options?: MessageHistoryOptions): Promise<MessagePage>;
    /** Register before catch-up, then deliver durable messages exactly once in ascending seq per watch. */
    watch(sessionId: string, options: MessageWatchOptions): Promise<MessageSubscription>;
    send(input: SendMessageInput): Promise<SendMessageReceipt>;
}

export type MessageHistoryOptions = { limit?: number; afterSeq?: number; beforeSeq?: number; signal?: AbortSignal };
export type MessagePage = { messages: Message[]; hasMore: boolean };
export type MessageWatchOptions = {
    afterSeq: number;
    onMessage: (message: Message) => void;
    onError?: (error: PawsAgentError) => void;
    signal?: AbortSignal;
};
export type MessageSubscription = {
    unsubscribe(): void;
    /** Retry transport failures or explicitly catch up. Protocol/decryption failures require a new watch. */
    sync(): Promise<void>;
};

export interface RequestsResource {
    approve(input: ResolveRequestInput): Promise<void>;
    reject(input: ResolveRequestInput): Promise<void>;
}

export type PawsAgentEvent =
    | { type: 'connection'; state: ConnectionState }
    | { type: 'snapshot'; machines: Machine[]; sessions: Session[] }
    | { type: 'machines'; machines: Machine[] }
    | { type: 'message'; sessionId: string; message: Message }
    /** Provisional cumulative item snapshot; durable messages remain authoritative. */
    | { type: 'text-delta'; sessionId: string; turnId: string; itemId: string; delta: string; text: string }
    | { type: 'session'; session: Session }
    | { type: 'request'; sessionId: string; request: AgentRequest }
    | { type: 'error'; error: PawsAgentError };

export type PawsAgentEventListener = (event: PawsAgentEvent) => void;

export type PawsAgentClientOptions = {
    serverUrl: string;
    credentials: CredentialProvider;
    storage?: AgentStorage;
    logger?: AgentLogger;
    reconnect?: ReconnectPolicy;
};
