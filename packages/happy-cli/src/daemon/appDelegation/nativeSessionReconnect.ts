/** Reuse daemon-owned encryption after a native spawn created a session but failed before binding it. */
import { encodeBase64 } from '@/api/encryption';
import type { TrackedSession } from '../types';
import type { NativeLaunchPolicy } from './nativeLaunchPolicy';

export function nativeSessionReconnectEnvironment(
    policy: NativeLaunchPolicy,
    sessions: Iterable<TrackedSession>,
    isProcessActive: (pid: number) => boolean,
): Record<string, string> {
    const candidates = new Map<string, TrackedSession>();
    for (const session of sessions) {
        const application = session.happySessionMetadataFromLocalWebhook?.application;
        if (session.happySessionId && application?.appId === policy.binding.appId && application.bindingId === policy.binding.id) {
            candidates.set(session.happySessionId, session);
        }
    }
    if (!candidates.size) return {};
    if (candidates.size !== 1) throw new Error('Native session identity is ambiguous');
    const session = [...candidates.values()][0];
    const metadata = session.happySessionMetadataFromLocalWebhook!;
    const encryption = session.encryption;
    if (!encryption || metadata.machineId !== policy.binding.machineId || metadata.path !== policy.directory
        || (policy.binding.engine === 'codex' && metadata.codexAccountProfileId !== policy.binding.accountRef.id)) {
        throw new Error('Native session recovery identity mismatch');
    }
    if ([session.pid, metadata.hostPid].some(pid => typeof pid === 'number' && pid > 0 && isProcessActive(pid))) {
        throw new Error('resource-busy');
    }
    return {
        HAPPY_RECONNECT_SESSION_ID: session.happySessionId!,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(encryption.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: encryption.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(encryption.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(encryption.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(encryption.agentStateVersion),
        HAPPY_RECONNECT_METADATA_JSON: JSON.stringify(metadata),
    };
}
