import type { Session } from './storageTypes';
import type { ResumeSessionOptions } from './ops';
import type { ResumeCapabilityOptions } from '@/agents/resumeCapabilities';
import { canAgentResume, getAgentVendorResumeId } from '@/agents/resumeCapabilities';
import { getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';
import type { PermissionModeOverrideForSpawn } from '@/sync/permissionModeOverride';

export type ResumeSessionBaseOptions = Omit<
    ResumeSessionOptions,
    'sessionEncryptionKeyBase64' | 'sessionEncryptionVariant'
>;

export function buildResumeSessionBaseOptionsFromSession(opts: {
    sessionId: string;
    session: Session;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    permissionOverride?: PermissionModeOverrideForSpawn | null;
}): ResumeSessionBaseOptions | null {
    const { sessionId, session, resumeCapabilityOptions, permissionOverride } = opts;

    const machineId = session.metadata?.machineId;
    const directory = session.metadata?.path;
    const flavor = session.metadata?.flavor;
    if (!machineId || !directory || !flavor) return null;

    const agentId = resolveAgentIdFromFlavor(flavor);
    if (!agentId) return null;

    // Note: vendor resume IDs can be missing even for otherwise-resumable sessions.
    // Wake/resume still needs to work (e.g. pending-queue wake) and should attach the vendor id only when present.
    if (!canAgentResume(flavor, resumeCapabilityOptions)) return null;

    const resume = getAgentVendorResumeId(session.metadata, agentId, resumeCapabilityOptions);

    return {
        sessionId,
        machineId,
        directory,
        agent: getAgentCore(agentId).cli.spawnAgent,
        ...(resume ? { resume } : {}),
        ...(permissionOverride ? permissionOverride : {}),
    };
}
