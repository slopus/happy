import { Socket } from "socket.io";
import { log } from "@/utils/log";
import { GitHubProfile } from "@/app/api/types";
import { AccountProfile } from "@/types";
import { getPublicUrl } from "@/storage/files";
import { db } from "@/storage/db";
import { allocateUserSeq } from "@/storage/seq";

// === CONNECTION TYPES ===

export interface SessionScopedConnection {
    connectionType: 'session-scoped';
    socket: Socket;
    userId: string;
    sessionId: string;
    supportsMessageReceipt: boolean;
}

export interface UserScopedConnection {
    connectionType: 'user-scoped';
    socket: Socket;
    userId: string;
}

export interface MachineScopedConnection {
    connectionType: 'machine-scoped';
    socket: Socket;
    userId: string;
    machineId: string;
}

export type ClientConnection = SessionScopedConnection | UserScopedConnection | MachineScopedConnection;

// === RECIPIENT FILTER TYPES ===

export type RecipientFilter =
    | { type: 'all-interested-in-session'; sessionId: string }
    | { type: 'user-scoped-only' }
    | { type: 'machine-scoped-only'; machineId: string }  // For update-machine: sends to user-scoped + only the specific machine
    | { type: 'all-user-authenticated-connections' };

// === UPDATE EVENT TYPES (Persistent) ===

export type UpdateEvent = {
    type: 'new-message';
    sessionId: string;
    message: {
        id: string;
        seq: number;
        content: any;
        localId: string | null;
        createdAt: number;
        updatedAt: number;
    }
} | {
    type: 'new-session';
    sessionId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-session';
    sessionId: string;
    metadata?: {
        value: string | null;
        version: number;
    } | null | undefined;
    agentState?: {
        value: string | null;
        version: number;
    } | null | undefined;
} | {
    type: 'update-account';
    userId: string;
    settings?: {
        value: string | null;
        version: number;
    } | null | undefined;
    github?: GitHubProfile | null | undefined;
} | {
    type: 'new-machine';
    machineId: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-machine';
    machineId: string;
    metadata?: {
        value: string;
        version: number;
    };
    daemonState?: {
        value: string;
        version: number;
    };
    activeAt?: number;
} | {
    type: 'new-artifact';
    artifactId: string;
    seq: number;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string | null;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-artifact';
    artifactId: string;
    header?: {
        value: string;
        version: number;
    };
    body?: {
        value: string;
        version: number;
    };
} | {
    type: 'delete-artifact';
    artifactId: string;
} | {
    type: 'delete-session';
    sessionId: string;
} | {
    type: 'relationship-updated';
    uid: string;
    status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
    timestamp: number;
} | {
    type: 'new-feed-post';
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
    badge: boolean;
    meta: Record<string, unknown> | null;
} | {
    type: 'kv-batch-update';
    changes: Array<{
        key: string;
        value: string | null; // null indicates deletion
        version: number; // -1 for deleted keys
    }>;
} | {
    type: 'new-openclaw-machine';
    machineId: string;
    machineType: 'happy' | 'direct';
    happyMachineId: string | null;
    directConfig: string | null;
    metadata: string;
    metadataVersion: number;
    pairingData: string | null;
    dataEncryptionKey: string | null;
    seq: number;
    createdAt: number;
    updatedAt: number;
} | {
    type: 'update-openclaw-machine';
    machineId: string;
    metadata?: {
        value: string;
        version: number;
    };
    pairingData?: string | null;
    directConfig?: string | null;
} | {
    type: 'delete-openclaw-machine';
    machineId: string;
} | {
    type: 'session-shared';
    sessionId: string;
    shareId: string;
    sharedBy: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: any | null;
    };
    accessLevel: 'view' | 'edit' | 'admin';
    encryptedDataKey: string;
    createdAt: number;
} | {
    type: 'session-share-updated';
    sessionId: string;
    shareId: string;
    accessLevel: 'view' | 'edit' | 'admin';
    updatedAt: number;
} | {
    type: 'session-share-revoked';
    sessionId: string;
    shareId: string;
} | {
    type: 'public-share-created';
    sessionId: string;
    publicShareId: string;
    token: string;
    expiresAt: number | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    createdAt: number;
} | {
    type: 'public-share-updated';
    sessionId: string;
    publicShareId: string;
    expiresAt: number | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    updatedAt: number;
} | {
    type: 'public-share-deleted';
    sessionId: string;
};

// === EPHEMERAL EVENT TYPES (Transient) ===

export type EphemeralEvent = {
    type: 'activity';
    id: string;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
} | {
    type: 'message-syncing';
    id: string;
    count: number;
} | {
    type: 'message-synced';
    id: string;
    count: number;
} | {
    type: 'message-errored';
    id: string;
    error: string;
} | {
    type: 'message-delivery-error';
    sid: string;
    messageId: string;
    localId: string | null;
    error: string;
} | {
    type: 'message-delivery-cleared';
    sid: string;
    messageId: string;
    localId: string | null;
} | {
    type: 'pending-message-upsert';
    sid: string;
    pending: {
        id: string;
        localId: string;
        content: any;
        sentBy: string | null;
        sentByName: string | null;
        trackCliDelivery: boolean;
        pinnedAt: number | null;
        createdAt: number;
        updatedAt: number;
    };
} | {
    type: 'pending-message-delete';
    sid: string;
    pendingId: string;
} | {
    type: 'machine-activity';
    id: string;
    active: boolean;
    activeAt: number;
} | {
    type: 'usage';
    id: string;
    key: string;
    tokens: Record<string, number>;
    cost: Record<string, number>;
    timestamp: number;
} | {
    type: 'machine-status';
    machineId: string;
    online: boolean;
    timestamp: number;
} | {
    type: 'orchestrator-activity';
    controllerSessionId: string;
    activity: Record<string, string[]>;
} | {
    type: 'orchestrator-run-terminal';
    runId: string;
    status: string;
    title: string;
};

// === EVENT PAYLOAD TYPES ===

export interface UpdatePayload {
    id: string;
    seq: number;
    body: {
        t: UpdateEvent['type'];
        [key: string]: any;
    };
    createdAt: number;
}

export interface EphemeralPayload {
    type: EphemeralEvent['type'];
    [key: string]: any;
}

type DeliveryStats = {
    total: number;
    sessionScoped: number;
};

// === EVENT ROUTER CLASS ===

class EventRouter {
    private userConnections = new Map<string, Set<ClientConnection>>();

    // === CONNECTION MANAGEMENT ===

    addConnection(userId: string, connection: ClientConnection): void {
        if (!this.userConnections.has(userId)) {
            this.userConnections.set(userId, new Set());
        }
        this.userConnections.get(userId)!.add(connection);
    }

    removeConnection(userId: string, connection: ClientConnection): void {
        const connections = this.userConnections.get(userId);
        if (connections) {
            connections.delete(connection);
            if (connections.size === 0) {
                this.userConnections.delete(userId);
            }
        }
    }

    getConnections(userId: string): Set<ClientConnection> | undefined {
        return this.userConnections.get(userId);
    }

    // === EVENT EMISSION METHODS ===

    emitUpdate(params: {
        userId: string;
        payload: UpdatePayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): DeliveryStats {
        return this.emit({
            userId: params.userId,
            eventName: 'update',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    /**
     * Emit an update to the session owner AND all users who have been shared this session.
     * Each user gets their own seq number via allocateUserSeq.
     */
    async emitToSessionSubscribers(params: {
        ownerId: string;
        sessionId: string;
        buildPayload: (userId: string, seq: number) => UpdatePayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): Promise<{ ownerDelivery: DeliveryStats }> {
        // 1. Emit to owner
        const ownerSeq = await allocateUserSeq(params.ownerId);
        const ownerDelivery = this.emitUpdate({
            userId: params.ownerId,
            payload: params.buildPayload(params.ownerId, ownerSeq),
            recipientFilter: params.recipientFilter,
            skipSenderConnection: params.skipSenderConnection
        });

        // 2. Find shared users and emit to each
        const shares = await db.sessionShare.findMany({
            where: { sessionId: params.sessionId },
            select: { sharedWithUserId: true }
        });
        for (const share of shares) {
            const seq = await allocateUserSeq(share.sharedWithUserId);
            this.emitUpdate({
                userId: share.sharedWithUserId,
                payload: params.buildPayload(share.sharedWithUserId, seq)
            });
        }

        return { ownerDelivery };
    }

    emitEphemeral(params: {
        userId: string;
        payload: EphemeralPayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): DeliveryStats {
        return this.emit({
            userId: params.userId,
            eventName: 'ephemeral',
            payload: params.payload,
            recipientFilter: params.recipientFilter || { type: 'all-user-authenticated-connections' },
            skipSenderConnection: params.skipSenderConnection
        });
    }

    /**
     * Emit an ephemeral event to the session owner AND all users who have been shared this session.
     */
    async emitEphemeralToSessionSubscribers(params: {
        ownerId: string;
        sessionId: string;
        payload: EphemeralPayload;
        recipientFilter?: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): Promise<void> {
        // 1. Emit to owner
        this.emitEphemeral({
            userId: params.ownerId,
            payload: params.payload,
            recipientFilter: params.recipientFilter,
            skipSenderConnection: params.skipSenderConnection
        });

        // 2. Find shared users and emit to each
        const shares = await db.sessionShare.findMany({
            where: { sessionId: params.sessionId },
            select: { sharedWithUserId: true }
        });
        for (const share of shares) {
            this.emitEphemeral({
                userId: share.sharedWithUserId,
                payload: params.payload
            });
        }
    }

    // === PRIVATE ROUTING LOGIC ===

    private shouldSendToConnection(
        connection: ClientConnection,
        filter: RecipientFilter
    ): boolean {
        switch (filter.type) {
            case 'all-interested-in-session':
                // Send to session-scoped with matching session + all user-scoped
                if (connection.connectionType === 'session-scoped') {
                    if (connection.sessionId !== filter.sessionId) {
                        return false;  // Wrong session
                    }
                } else if (connection.connectionType === 'machine-scoped') {
                    return false;  // Machines don't need session updates
                }
                // user-scoped always gets it
                return true;

            case 'user-scoped-only':
                return connection.connectionType === 'user-scoped';

            case 'machine-scoped-only':
                // Send to user-scoped (mobile/web needs all machine updates) + only the specific machine
                if (connection.connectionType === 'user-scoped') {
                    return true;
                }
                if (connection.connectionType === 'machine-scoped') {
                    return connection.machineId === filter.machineId;
                }
                return false;  // session-scoped doesn't need machine updates

            case 'all-user-authenticated-connections':
                // Send to all connection types (default behavior)
                return true;

            default:
                return false;
        }
    }

    private emit(params: {
        userId: string;
        eventName: 'update' | 'ephemeral';
        payload: any;
        recipientFilter: RecipientFilter;
        skipSenderConnection?: ClientConnection;
    }): DeliveryStats {
        const connections = this.userConnections.get(params.userId);
        if (!connections) {
            log({ module: 'websocket', level: 'warn' }, `No connections found for user ${params.userId}`);
            return { total: 0, sessionScoped: 0 };
        }

        let total = 0;
        let sessionScoped = 0;
        for (const connection of connections) {
            // Skip message echo
            if (params.skipSenderConnection && connection === params.skipSenderConnection) {
                continue;
            }

            // Apply recipient filter
            if (!this.shouldSendToConnection(connection, params.recipientFilter)) {
                continue;
            }

            connection.socket.emit(params.eventName, params.payload);
            total += 1;
            if (connection.connectionType === 'session-scoped') {
                sessionScoped += 1;
            }
        }

        return { total, sessionScoped };
    }
}

export const eventRouter = new EventRouter();

// === EVENT BUILDER FUNCTIONS ===

export function buildNewSessionUpdate(session: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-session',
            id: session.id,
            seq: session.seq,
            metadata: session.metadata,
            metadataVersion: session.metadataVersion,
            agentState: session.agentState,
            agentStateVersion: session.agentStateVersion,
            dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
            active: session.active,
            activeAt: session.lastActiveAt.getTime(),
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildNewMessageUpdate(message: {
    id: string;
    seq: number;
    content: any;
    localId: string | null;
    sentBy: string | null;
    sentByName: string | null;
    createdAt: Date;
    updatedAt: Date;
}, sessionId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-message',
            sid: sessionId,
            message: {
                id: message.id,
                seq: message.seq,
                content: message.content,
                localId: message.localId,
                sentBy: message.sentBy,
                sentByName: message.sentByName,
                createdAt: message.createdAt.getTime(),
                updatedAt: message.updatedAt.getTime()
            }
        },
        createdAt: Date.now()
    };
}

export function buildUpdateSessionUpdate(sessionId: string, updateSeq: number, updateId: string, metadata?: { value: string; version: number }, agentState?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-session',
            id: sessionId,
            metadata,
            agentState
        },
        createdAt: Date.now()
    };
}

export function buildDeleteSessionUpdate(sessionId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-session',
            sid: sessionId
        },
        createdAt: Date.now()
    };
}

export function buildUpdateAccountUpdate(userId: string, profile: Partial<AccountProfile>, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-account',
            id: userId,
            ...profile,
            avatar: profile.avatar ? { ...profile.avatar, url: getPublicUrl(profile.avatar.path) } : undefined
        },
        createdAt: Date.now()
    };
}

export function buildNewMachineUpdate(machine: {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-machine',
            machineId: machine.id,
            seq: machine.seq,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState,
            daemonStateVersion: machine.daemonStateVersion,
            dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
            active: machine.active,
            activeAt: machine.lastActiveAt.getTime(),
            createdAt: machine.createdAt.getTime(),
            updatedAt: machine.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateMachineUpdate(machineId: string, updateSeq: number, updateId: string, metadata?: { value: string; version: number }, daemonState?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-machine',
            machineId,
            metadata,
            daemonState
        },
        createdAt: Date.now()
    };
}

export function buildSessionActivityEphemeral(sessionId: string, active: boolean, activeAt: number, thinking?: boolean): EphemeralPayload {
    return {
        type: 'activity',
        id: sessionId,
        active,
        activeAt,
        thinking: thinking || false
    };
}

export function buildMachineActivityEphemeral(machineId: string, active: boolean, activeAt: number): EphemeralPayload {
    return {
        type: 'machine-activity',
        id: machineId,
        active,
        activeAt
    };
}

export function buildMessageSyncingEphemeral(sessionId: string, count: number): EphemeralPayload {
    return {
        type: 'message-syncing',
        id: sessionId,
        count
    };
}

export function buildMessageSyncedEphemeral(sessionId: string, count: number): EphemeralPayload {
    return {
        type: 'message-synced',
        id: sessionId,
        count
    };
}

export function buildMessageErrorEphemeral(sessionId: string, error: string): EphemeralPayload {
    return {
        type: 'message-errored',
        id: sessionId,
        error
    };
}

export function buildMessageDeliveryErrorEphemeral(sessionId: string, messageId: string, localId: string | null, error: string): EphemeralPayload {
    return {
        type: 'message-delivery-error',
        sid: sessionId,
        messageId,
        localId,
        error
    };
}

export function buildMessageDeliveryClearedEphemeral(sessionId: string, messageId: string, localId: string | null): EphemeralPayload {
    return {
        type: 'message-delivery-cleared',
        sid: sessionId,
        messageId,
        localId
    };
}

export function buildPendingMessageUpsertEphemeral(sessionId: string, pending: {
    id: string;
    localId: string;
    content: any;
    sentBy: string | null;
    sentByName: string | null;
    trackCliDelivery: boolean;
    pinnedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}): EphemeralPayload {
    return {
        type: 'pending-message-upsert',
        sid: sessionId,
        pending: {
            id: pending.id,
            localId: pending.localId,
            content: pending.content,
            sentBy: pending.sentBy,
            sentByName: pending.sentByName,
            trackCliDelivery: pending.trackCliDelivery,
            pinnedAt: pending.pinnedAt ? pending.pinnedAt.getTime() : null,
            createdAt: pending.createdAt.getTime(),
            updatedAt: pending.updatedAt.getTime(),
        },
    };
}

export function buildPendingMessageDeleteEphemeral(sessionId: string, pendingId: string): EphemeralPayload {
    return {
        type: 'pending-message-delete',
        sid: sessionId,
        pendingId,
    };
}

export function buildUsageEphemeral(sessionId: string, key: string, tokens: Record<string, number>, cost: Record<string, number>): EphemeralPayload {
    return {
        type: 'usage',
        id: sessionId,
        key,
        tokens,
        cost,
        timestamp: Date.now()
    };
}

export function buildMachineStatusEphemeral(machineId: string, online: boolean): EphemeralPayload {
    return {
        type: 'machine-status',
        machineId,
        online,
        timestamp: Date.now()
    };
}

export function buildOrchestratorActivityEphemeral(controllerSessionId: string, activity: Record<string, string[]>, totalRunCount?: number): EphemeralPayload {
    return {
        type: 'orchestrator-activity',
        controllerSessionId,
        activity,
        ...(totalRunCount !== undefined && { totalRunCount }),
    };
}

export function buildOrchestratorRunTerminalEphemeral(
    runId: string, status: string, title: string
): EphemeralPayload {
    return {
        type: 'orchestrator-run-terminal',
        runId,
        status,
        title,
    };
}

export function buildNewArtifactUpdate(artifact: {
    id: string;
    seq: number;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-artifact',
            artifactId: artifact.id,
            seq: artifact.seq,
            header: Buffer.from(artifact.header).toString('base64'),
            headerVersion: artifact.headerVersion,
            body: Buffer.from(artifact.body).toString('base64'),
            bodyVersion: artifact.bodyVersion,
            dataEncryptionKey: Buffer.from(artifact.dataEncryptionKey).toString('base64'),
            createdAt: artifact.createdAt.getTime(),
            updatedAt: artifact.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateArtifactUpdate(artifactId: string, updateSeq: number, updateId: string, header?: { value: string; version: number }, body?: { value: string; version: number }): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-artifact',
            artifactId,
            header,
            body
        },
        createdAt: Date.now()
    };
}

export function buildDeleteArtifactUpdate(artifactId: string, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-artifact',
            artifactId
        },
        createdAt: Date.now()
    };
}

export function buildRelationshipUpdatedEvent(
    data: {
        uid: string;
        status: 'none' | 'requested' | 'pending' | 'friend' | 'rejected';
        timestamp: number;
    },
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'relationship-updated',
            ...data
        },
        createdAt: Date.now()
    };
}

export function buildNewFeedPostUpdate(feedItem: {
    id: string;
    body: any;
    cursor: string;
    createdAt: number;
    repeatKey: string | null;
    badge: boolean;
    meta: Record<string, unknown> | null;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-feed-post',
            id: feedItem.id,
            body: feedItem.body,
            cursor: feedItem.cursor,
            createdAt: feedItem.createdAt,
            repeatKey: feedItem.repeatKey,
            badge: feedItem.badge,
            meta: feedItem.meta
        },
        createdAt: Date.now()
    };
}

export function buildKVBatchUpdateUpdate(
    changes: Array<{ key: string; value: string | null; version: number }>,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'kv-batch-update',
            changes
        },
        createdAt: Date.now()
    };
}

export function buildNewOpenClawMachineUpdate(machine: {
    id: string;
    type: string;
    happyMachineId: string | null;
    directConfig: string | null;
    metadata: string;
    metadataVersion: number;
    pairingData: string | null;
    dataEncryptionKey: Uint8Array | null;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'new-openclaw-machine',
            machineId: machine.id,
            machineType: machine.type as 'happy' | 'direct',
            happyMachineId: machine.happyMachineId,
            directConfig: machine.directConfig,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            pairingData: machine.pairingData,
            dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
            seq: machine.seq,
            createdAt: machine.createdAt.getTime(),
            updatedAt: machine.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildUpdateOpenClawMachineUpdate(
    machineId: string,
    updateSeq: number,
    updateId: string,
    updates: {
        metadata?: { value: string; version: number };
        pairingData?: string | null;
        directConfig?: string | null;
    }
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'update-openclaw-machine',
            machineId,
            ...updates
        },
        createdAt: Date.now()
    };
}

export function buildDeleteOpenClawMachineUpdate(
    machineId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'delete-openclaw-machine',
            machineId
        },
        createdAt: Date.now()
    };
}

export function buildSessionSharedUpdate(share: {
    id: string;
    sessionId: string;
    sharedByUser: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: any | null;
    };
    accessLevel: 'view' | 'edit' | 'admin';
    encryptedDataKey: Uint8Array;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-shared',
            sessionId: share.sessionId,
            shareId: share.id,
            sharedBy: share.sharedByUser,
            accessLevel: share.accessLevel,
            encryptedDataKey: Buffer.from(share.encryptedDataKey).toString('base64'),
            createdAt: share.createdAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildSessionShareUpdatedUpdate(
    shareId: string,
    sessionId: string,
    accessLevel: 'view' | 'edit' | 'admin',
    updatedAt: Date,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-share-updated',
            sessionId,
            shareId,
            accessLevel,
            updatedAt: updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildSessionShareRevokedUpdate(
    shareId: string,
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'session-share-revoked',
            sessionId,
            shareId
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareCreatedUpdate(publicShare: {
    id: string;
    sessionId: string;
    token: string;
    expiresAt: Date | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    createdAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-created',
            sessionId: publicShare.sessionId,
            publicShareId: publicShare.id,
            token: publicShare.token,
            expiresAt: publicShare.expiresAt?.getTime() ?? null,
            maxUses: publicShare.maxUses,
            isConsentRequired: publicShare.isConsentRequired,
            createdAt: publicShare.createdAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareUpdatedUpdate(publicShare: {
    id: string;
    sessionId: string;
    expiresAt: Date | null;
    maxUses: number | null;
    isConsentRequired: boolean;
    updatedAt: Date;
}, updateSeq: number, updateId: string): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-updated',
            sessionId: publicShare.sessionId,
            publicShareId: publicShare.id,
            expiresAt: publicShare.expiresAt?.getTime() ?? null,
            maxUses: publicShare.maxUses,
            isConsentRequired: publicShare.isConsentRequired,
            updatedAt: publicShare.updatedAt.getTime()
        },
        createdAt: Date.now()
    };
}

export function buildPublicShareDeletedUpdate(
    sessionId: string,
    updateSeq: number,
    updateId: string
): UpdatePayload {
    return {
        id: updateId,
        seq: updateSeq,
        body: {
            t: 'public-share-deleted',
            sessionId
        },
        createdAt: Date.now()
    };
}
