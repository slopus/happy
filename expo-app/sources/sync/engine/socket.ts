import { ApiEphemeralUpdateSchema, ApiUpdateContainerSchema } from '../apiTypes';
import type { ApiEphemeralActivityUpdate, ApiUpdateContainer } from '../apiTypes';
import type { Encryption } from '../encryption/encryption';
import type { NormalizedMessage } from '../typesRaw';
import type { Session } from '../storageTypes';
import type { Machine } from '../storageTypes';
import { storage } from '../storage';
import { projectManager } from '../projectManager';
import { gitStatusSync } from '../gitStatusSync';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import { didControlReturnToMobile } from '../controlledByUserTransitions';
import {
    buildUpdatedSessionFromSocketUpdate,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
} from './sessions';
import {
    buildMachineFromMachineActivityEphemeralUpdate,
    buildUpdatedMachineFromSocketUpdate,
} from './machines';
import { handleUpdateAccountSocketUpdate } from './account';
import {
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
} from './artifacts';
import {
    handleNewFeedPostUpdate,
    handleRelationshipUpdatedSocketUpdate,
    handleTodoKvBatchUpdate,
} from './feed';

export function parseUpdateContainer(update: unknown) {
    const validatedUpdate = ApiUpdateContainerSchema.safeParse(update);
    if (!validatedUpdate.success) {
        console.error('❌ Sync: Invalid update data:', update);
        return null;
    }
    return validatedUpdate.data;
}

export function parseEphemeralUpdate(update: unknown) {
    const validatedUpdate = ApiEphemeralUpdateSchema.safeParse(update);
    if (!validatedUpdate.success) {
        console.error('Invalid ephemeral update received:', update);
        return null;
    }
    return validatedUpdate.data;
}

export function handleSocketReconnected(params: {
    log: { log: (message: string) => void };
    invalidateSessions: () => void;
    invalidateMachines: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    getSessionsData: () => any;
    invalidateMessagesForSession: (sessionId: string) => void;
    invalidateGitStatusForSession: (sessionId: string) => void;
}) {
    const {
        log,
        invalidateSessions,
        invalidateMachines,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        getSessionsData,
        invalidateMessagesForSession,
        invalidateGitStatusForSession,
    } = params;

    log.log('🔌 Socket reconnected');
    invalidateSessions();
    invalidateMachines();
    log.log('🔌 Socket reconnected: Invalidating artifacts sync');
    invalidateArtifacts();
    invalidateFriends();
    invalidateFriendRequests();
    invalidateFeed();

    const sessionsData = getSessionsData();
    if (sessionsData) {
        for (const item of sessionsData as any[]) {
            if (typeof item !== 'string') {
                invalidateMessagesForSession(item.id);
                // Also invalidate git status on reconnection
                invalidateGitStatusForSession(item.id);
            }
        }
    }
}

type ApplySessions = (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;

export async function handleSocketUpdate(params: {
    update: unknown;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateTodos: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        update,
        encryption,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateTodos,
        log,
    } = params;

    const updateData = parseUpdateContainer(update);
    if (!updateData) return;

    await handleUpdateContainer({
        updateData,
        encryption,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateTodos,
        log,
    });
}

export async function handleUpdateContainer(params: {
    updateData: ApiUpdateContainer;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateTodos: () => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        updateData,
        encryption,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateTodos,
        log,
    } = params;

    if (updateData.body.t === 'new-message') {
        await handleNewMessageSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            applySessions: (sessions) => applySessions(sessions),
            fetchSessions,
            applyMessages,
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateGitStatus: (sessionId) => gitStatusSync.invalidate(sessionId),
            onSessionVisible,
        });
    } else if (updateData.body.t === 'new-session') {
        log.log('🆕 New session update received');
        invalidateSessions();
    } else if (updateData.body.t === 'delete-session') {
        log.log('🗑️ Delete session update received');
        handleDeleteSessionSocketUpdate({
            sessionId: updateData.body.sid,
            deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
            removeSessionEncryption: (sessionId) => encryption.removeSessionEncryption(sessionId),
            removeProjectManagerSession: (sessionId) => projectManager.removeSession(sessionId),
            clearGitStatusForSession: (sessionId) => gitStatusSync.clearForSession(sessionId),
            log,
        });
    } else if (updateData.body.t === 'update-session') {
        const session = storage.getState().sessions[updateData.body.id];
        if (session) {
            // Get session encryption
            const sessionEncryption = encryption.getSessionEncryption(updateData.body.id);
            if (!sessionEncryption) {
                console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
                return;
            }

            const { nextSession, agentState } = await buildUpdatedSessionFromSocketUpdate({
                session,
                updateBody: updateData.body,
                updateSeq: updateData.seq,
                updateCreatedAt: updateData.createdAt,
                sessionEncryption,
            });

            applySessions([nextSession]);

            // Invalidate git status when agent state changes (files may have been modified)
            if (updateData.body.agentState) {
                gitStatusSync.invalidate(updateData.body.id);

                // Check for new permission requests and notify voice assistant
                if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
                    const requestIds = Object.keys(agentState.requests);
                    const firstRequest = agentState.requests[requestIds[0]];
                    const toolName = firstRequest?.tool;
                    voiceHooks.onPermissionRequested(
                        updateData.body.id,
                        requestIds[0],
                        toolName,
                        firstRequest?.arguments,
                    );
                }

                // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                // This catches up on any messages that were exchanged while desktop had control
                const wasControlledByUser = session.agentState?.controlledByUser;
                const isNowControlledByUser = agentState?.controlledByUser;
                if (didControlReturnToMobile(wasControlledByUser, isNowControlledByUser)) {
                    log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                    onSessionVisible(updateData.body.id);
                }
            }
        }
    } else if (updateData.body.t === 'update-account') {
        const accountUpdate = updateData.body;
        const currentProfile = storage.getState().profile;

        await handleUpdateAccountSocketUpdate({
            accountUpdate,
            updateCreatedAt: updateData.createdAt,
            currentProfile,
            encryption,
            applyProfile: (profile) => storage.getState().applyProfile(profile),
            applySettings: (settings, version) => storage.getState().applySettings(settings, version),
            log,
        });
    } else if (updateData.body.t === 'update-machine') {
        const machineUpdate = updateData.body;
        const machineId = machineUpdate.machineId; // Changed from .id to .machineId
        const machine = storage.getState().machines[machineId];

        const updatedMachine = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate,
            updateSeq: updateData.seq,
            updateCreatedAt: updateData.createdAt,
            existingMachine: machine,
            getMachineEncryption: (id) => encryption.getMachineEncryption(id),
        });
        if (!updatedMachine) return;

        // Update storage using applyMachines which rebuilds sessionListViewData
        storage.getState().applyMachines([updatedMachine]);
    } else if (updateData.body.t === 'relationship-updated') {
        log.log('👥 Received relationship-updated update');
        const relationshipUpdate = updateData.body;

        handleRelationshipUpdatedSocketUpdate({
            relationshipUpdate,
            applyRelationshipUpdate: (update) => storage.getState().applyRelationshipUpdate(update),
            invalidateFriends,
            invalidateFriendRequests,
            invalidateFeed,
        });
    } else if (updateData.body.t === 'new-artifact') {
        log.log('📦 Received new-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleNewArtifactSocketUpdate({
            artifactId,
            dataEncryptionKey: artifactUpdate.dataEncryptionKey,
            header: artifactUpdate.header,
            headerVersion: artifactUpdate.headerVersion,
            body: artifactUpdate.body,
            bodyVersion: artifactUpdate.bodyVersion,
            seq: artifactUpdate.seq,
            createdAt: artifactUpdate.createdAt,
            updatedAt: artifactUpdate.updatedAt,
            encryption,
            artifactDataKeys,
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
            log,
        });
    } else if (updateData.body.t === 'update-artifact') {
        log.log('📦 Received update-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleUpdateArtifactSocketUpdate({
            artifactId,
            seq: updateData.seq,
            createdAt: updateData.createdAt,
            header: artifactUpdate.header,
            body: artifactUpdate.body,
            artifactDataKeys,
            getExistingArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            invalidateArtifactsSync: invalidateArtifacts,
            log,
        });
    } else if (updateData.body.t === 'delete-artifact') {
        log.log('📦 Received delete-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        handleDeleteArtifactSocketUpdate({
            artifactId,
            deleteArtifact: (id) => storage.getState().deleteArtifact(id),
            artifactDataKeys,
        });
    } else if (updateData.body.t === 'new-feed-post') {
        log.log('📰 Received new-feed-post update');
        const feedUpdate = updateData.body;

        await handleNewFeedPostUpdate({
            feedUpdate,
            assumeUsers,
            getUsers: () => storage.getState().users,
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    } else if (updateData.body.t === 'kv-batch-update') {
        log.log('📝 Received kv-batch-update');
        const kvUpdate = updateData.body;

        await handleTodoKvBatchUpdate({
            kvUpdate,
            applyTodoSocketUpdates,
            invalidateTodosSync: invalidateTodos,
            log,
        });
    }
}

export function flushActivityUpdates(params: { updates: Map<string, ApiEphemeralActivityUpdate>; applySessions: ApplySessions }): void {
    const { updates, applySessions } = params;

    const sessions: Session[] = [];

    for (const [sessionId, update] of updates) {
        const session = storage.getState().sessions[sessionId];
        if (session) {
            sessions.push({
                ...session,
                active: update.active,
                activeAt: update.activeAt,
                thinking: update.thinking ?? false,
                thinkingAt: update.activeAt, // Always use activeAt for consistency
            });
        }
    }

    if (sessions.length > 0) {
        applySessions(sessions);
    }
}

export function handleEphemeralSocketUpdate(params: {
    update: unknown;
    addActivityUpdate: (update: any) => void;
}): void {
    const { update, addActivityUpdate } = params;

    const updateData = parseEphemeralUpdate(update);
    if (!updateData) return;

    // Process activity updates through smart debounce accumulator
    if (updateData.type === 'activity') {
        addActivityUpdate(updateData);
    }

    // Handle machine activity updates
    if (updateData.type === 'machine-activity') {
        // Update machine's active status and lastActiveAt
        const machine = storage.getState().machines[updateData.id];
        if (machine) {
            const updatedMachine: Machine = buildMachineFromMachineActivityEphemeralUpdate({ machine, updateData });
            storage.getState().applyMachines([updatedMachine]);
        }
    }

    // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
}
