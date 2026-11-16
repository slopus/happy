import type { Metadata, Session } from '@/sync/storageTypes';

export function getLatestSessionModelMetadata(args: {
    sessions: Array<Session | string> | null | undefined;
    selectedMachineId: string | null | undefined;
    agent: string | null | undefined;
    /** undefined while binding is unknown; null explicitly selects native Codex. */
    codexAccountProfileId?: string | null;
}): Metadata | null {
    const { sessions, selectedMachineId, agent, codexAccountProfileId } = args;
    // A machine can run both native gateway and managed ChatGPT sessions.
    // Their catalogs cannot be reused across connections or account profiles.
    if (agent === 'codex' && (!selectedMachineId || codexAccountProfileId === undefined)) return null;
    let latest: Session | null = null;

    for (const entry of sessions ?? []) {
        if (typeof entry === 'string') {
            continue;
        }

        const metadata = entry.metadata;
        if (!metadata?.models?.length) {
            continue;
        }
        if (selectedMachineId && metadata.machineId !== selectedMachineId) {
            continue;
        }
        if (agent && metadata.flavor !== agent) {
            continue;
        }
        if (agent === 'codex' && (metadata.codexAccountProfileId ?? null) !== codexAccountProfileId) {
            continue;
        }

        if (!latest || entry.activeAt > latest.activeAt) {
            latest = entry;
        }
    }

    return latest?.metadata ?? null;
}
