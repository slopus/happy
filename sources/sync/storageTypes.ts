// Import shared types and schemas directly
import { 
    MetadataSchema, 
    AgentStateSchema, 
    MachineMetadataSchema,
    DaemonStateSchema,
    EncryptedMachineSchema,
    EncryptedSessionSchema,
    type Metadata,
    type AgentState,
    type MachineMetadata,
    type DaemonState,
    type Machine,
    type EncryptedMachine,
    type EncryptedSession
} from 'happy-api-client';

// Export the schemas and types we use
export { 
    MetadataSchema, 
    AgentStateSchema, 
    MachineMetadataSchema,
    DaemonStateSchema,
    EncryptedMachineSchema as MachineApiSchema, // Alias for compatibility
    EncryptedSessionSchema as SessionApiSchema,  // Alias for compatibility
    type Metadata,
    type AgentState,
    type MachineMetadata,
    type DaemonState,
    type Machine,
    type EncryptedMachine as MachineApi, // Alias for compatibility
    type EncryptedSession as SessionApi  // Alias for compatibility
};

// Mobile-specific Session interface with additional UI fields
// This is NOT in shared-types because it's mobile-specific
export interface Session {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: Metadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    // Mobile-specific fields for UI
    thinking: boolean;
    thinkingAt: number;
    presence: "online" | number;
    todos?: Array<{
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
        priority: 'high' | 'medium' | 'low';
        id: string;
    }>;
    draft?: string | null;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | null;
    // Local model mode, not synced to server
    modelMode?: 'default' | 'adaptiveUsage' | 'sonnet' | 'opus' | null;
}

// Mobile-specific types that aren't shared
export interface DecryptedMessage {
    id: string;
    seq: number | null;
    localId: string | null;
    content: any;
    createdAt: number;
}

export interface GitStatus {
    branch: string | null;
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    lastUpdatedAt: number;
    stagedLinesAdded: number;
    stagedLinesRemoved: number;
    unstagedLinesAdded: number;
    unstagedLinesRemoved: number;
    linesAdded: number;
    linesRemoved: number;
    linesChanged: number;
}