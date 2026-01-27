import type { ResumeSessionOptions } from './ops';
import type { Session } from './storageTypes';
import { resolveAgentIdFromFlavor, buildWakeResumeExtras } from '@/agents/catalog';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import type { PermissionModeOverrideForSpawn } from '@/sync/permissionModeOverride';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/resumeSessionBase';

export type PendingQueueWakeResumeOptions = Omit<
    ResumeSessionOptions,
    'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant'
>;

export function getPendingQueueWakeResumeOptions(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
}): PendingQueueWakeResumeOptions | null {
    const { sessionId, session, resumeCapabilityOptions, permissionOverride } = opts;

    // Only gate waking on "idle" when the session is actively running.
    // For inactive/archived sessions, `thinking` / `agentState.requests` can be stale; blocking wake would
    // strand pending-queue messages until the user sends another message (or the state refreshes).
    const isSessionActive = session.presence === 'online';
    if (isSessionActive) {
        if (session.thinking === true) return null;
        const requests = session.agentState?.requests;
        if (requests && Object.keys(requests).length > 0) return null;
    }

    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory || !flavor) return null;

    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
        permissionOverride,
    });
    if (!base) return null;

    return {
        ...base,
        ...buildWakeResumeExtras({ agentId, resumeCapabilityOptions }),
    };
}
