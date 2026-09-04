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

export type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'reconnecting';

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

export type SendMessageInput = {
    sessionId: string;
    text: string;
    localId?: string;
    meta?: Record<string, unknown>;
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
    spawn(input: SpawnSessionInput): Promise<SpawnSessionResult>;
    resume(input: ResumeSessionInput): Promise<SpawnSessionResult>;
    stop(sessionId: string): Promise<void>;
}

export interface MessagesResource {
    history(sessionId: string, options?: { limit?: number }): Promise<Message[]>;
    send(input: SendMessageInput): Promise<SendMessageReceipt>;
}

export interface RequestsResource {
    approve(input: ResolveRequestInput): Promise<void>;
    reject(input: ResolveRequestInput): Promise<void>;
}

export type PawsAgentEvent =
    | { type: 'connection'; state: ConnectionState }
    | { type: 'message'; sessionId: string; message: Message }
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
