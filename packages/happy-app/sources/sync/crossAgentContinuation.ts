import { MMKV } from 'react-native-mmkv';
import * as Crypto from 'expo-crypto';
import { accountStorageId, assertAccountRuntime } from '@/auth/accountRuntime';
import { storage } from './storage';
import { machineContinueWithAgent } from './ops';
import { ensureSessionHydratedWithRetry } from './ensureSessionHydratedWithRetry';
import { getCrossAgentTarget } from '@/utils/crossAgentContinuation';

// Keep the same request across an unknown transport outcome and across reloads.
const receipts = new MMKV({ id: accountStorageId('cross-agent-continuations') });
const pending = new Map<string, Promise<string>>();
export function createCrossAgentContinuation(sourceId: string, target: 'claude' | 'codex'): Promise<string> {
    const key = `${sourceId}:${target}`;
    const existing = pending.get(key); if (existing) return existing;
    const run = async () => {
        assertAccountRuntime();
        const source = storage.getState().sessions[sourceId];
        const machineId = source?.metadata?.machineId;
        const machine = machineId ? storage.getState().machines[machineId] : null;
        if (!source || !machineId || getCrossAgentTarget(source, machine) !== target) throw new Error('Cross-agent continuation is unavailable. Wait for the source to finish and check the machine connection.');
        const saved = receipts.getString(key);
        const record: { requestId: string; sessionId?: string } = saved ? JSON.parse(saved) : { requestId: Crypto.randomUUID() };
        receipts.set(key, JSON.stringify(record));
        if (!record.sessionId) {
            const result = await machineContinueWithAgent({ machineId, sourceSessionId: sourceId, targetAgent: target, requestId: record.requestId });
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : 'Source working directory is unavailable');
            record.sessionId = result.sessionId;
            // Save the remote receipt even if the selected account changed meanwhile.
            receipts.set(key, JSON.stringify(record));
        }
        assertAccountRuntime();
        if (!await ensureSessionHydratedWithRetry(record.sessionId)) throw new Error('The session was created but is not loaded yet. Retry to open it.');
        assertAccountRuntime();
        receipts.delete(key);
        return record.sessionId;
    };
    const promise = run().finally(() => pending.delete(key)); pending.set(key, promise); return promise;
}
