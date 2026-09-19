import { MMKV } from 'react-native-mmkv';
import { accountStorageId, assertAccountRuntime } from '@/auth/accountRuntime';
import { storage } from './storage';
import { machineSpawnNewSession, sessionUpdateMetadata, type SpawnSessionOptions } from './ops';
import { ensureSessionHydratedWithRetry } from './ensureSessionHydratedWithRetry';
import { createContinuationCoordinator, type ContinuationRecord } from './sessionContinuationCoordinator';
import { isMachineOnline } from '@/utils/machineUtils';
import { getSessionName } from '@/utils/sessionUtils';
import type { Session } from './storageTypes';

const receipts = new MMKV({ id: accountStorageId('session-continuations') });
export function continuationSpawnOptions(source: Session): SpawnSessionOptions {
    const metadata = source.metadata;
    const flavor = metadata?.flavor ?? 'claude';
    if (!metadata?.machineId || !metadata.path) throw new Error('continuation-missing-machine');
    if (!['claude', 'codex', 'ask', 'gemini', 'opencode', 'openclaw'].includes(flavor)) throw new Error('continuation-unsupported-agent');
    return { machineId: metadata.machineId, directory: metadata.path,
        agent: flavor as SpawnSessionOptions['agent'], approvedNewDirectoryCreation: false };
}
const continueSession = createContinuationCoordinator({
    assertCurrent: assertAccountRuntime,
    read: source => {
        const next = storage.getState().sessions[source]?.metadata?.continuedBySessionId;
        if (next) return { phase: 'ready', sessionId: next };
        const value = receipts.getString(source);
        return value ? JSON.parse(value) as ContinuationRecord : undefined;
    },
    write: (source, record) => receipts.set(source, JSON.stringify(record)),
    spawn: async id => {
        const source = storage.getState().sessions[id];
        if (!source) { receipts.delete(id); throw new Error('continuation-source-unavailable'); }
        let options: SpawnSessionOptions;
        try {
            options = continuationSpawnOptions(source);
            const machine = storage.getState().machines[options.machineId];
            if (!machine || !isMachineOnline(machine)) throw new Error('continuation-machine-offline');
        } catch (error) { receipts.delete(id); throw error; }
        // A thrown transport error has an unknown remote outcome. Keep starting
        // rather than silently spawning a second worker when the user retries.
        const result = await machineSpawnNewSession(options);
        if (result.type !== 'success') {
            if (result.type === 'error' && 'outcomeUnknown' in result && result.outcomeUnknown) throw new Error('continuation-outcome-unknown');
            receipts.delete(id);
            throw new Error(result.type === 'error' ? result.errorMessage : 'continuation-directory-missing');
        }
        return result.sessionId;
    },
    link: async (sourceId, targetId) => {
        if (!await ensureSessionHydratedWithRetry(targetId)) throw new Error('continuation-hydration-failed');
        assertAccountRuntime();
        const source = storage.getState().sessions[sourceId];
        const target = storage.getState().sessions[targetId];
        if (!source?.metadata || !target?.metadata) throw new Error('continuation-source-unavailable');
        const targetUpdate = await sessionUpdateMetadata(targetId, target.metadata, target.metadataVersion, metadata => ({
            ...metadata, continuationOfSessionId: sourceId,
            summary: { text: getSessionName(source), updatedAt: Date.now() },
        }));
        assertAccountRuntime();
        storage.getState().applySessions([{ ...storage.getState().sessions[targetId], metadata: targetUpdate.metadata, metadataVersion: targetUpdate.version }]);
        storage.getState().updateSessionPermissionMode(targetId, source.permissionMode ?? null);
        storage.getState().updateSessionModelMode(targetId, source.modelMode ?? null);
        storage.getState().updateSessionEffortLevel(targetId, source.effortLevel ?? null);
        storage.getState().updateSessionFastMode(targetId, source.fastMode ?? false);
        const sourceUpdate = await sessionUpdateMetadata(sourceId, source.metadata, source.metadataVersion, metadata => ({ ...metadata, continuedBySessionId: targetId }));
        assertAccountRuntime();
        storage.getState().applySessions([{ ...storage.getState().sessions[sourceId], metadata: sourceUpdate.metadata, metadataVersion: sourceUpdate.version }]);
    },
});

export async function createSessionContinuation(sourceId: string): Promise<string> {
    const id = await continueSession(sourceId);
    if (!await ensureSessionHydratedWithRetry(id)) throw new Error('continuation-hydration-failed');
    assertAccountRuntime();
    return id;
}
