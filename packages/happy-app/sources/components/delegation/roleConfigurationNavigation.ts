import type { Router } from 'expo-router';
import { flushDeviceStorageWrites } from '@/persistence/deviceStorage';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft, newSessionDraftSnapshot } from '@/hooks/useNewSessionDraft';
import { storage } from '@/sync/storage';
import { loadSessionDrafts } from '@/sync/persistence';
import { createRoleConfiguration, roleConfigurationCurrent, releaseDeletedRoleConfigurationSession, type RoleConfigurationRequest } from '@/sync/roleConfigurationHandoff';
import { t } from '@/text';
import { getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { isProjectSessionDeleted } from '@/sync/projectSessionLinks';
import { sync } from '@/sync/sync';

/** Preserve any text already being written in a retained conversation. */
export function appendRoleConfigurationPrompt(current: string, prompt: string) {
    if (current.includes(prompt)) return current;
    return current.trim() ? `${current}\n\n${prompt}` : prompt;
}
export async function openRoleConfiguration(router: Router, request: RoleConfigurationRequest): Promise<void> {
    const owner = getFirstSubmissionScope();
    const record = await createRoleConfiguration(request, newSessionDraftSnapshot(useNewSessionDraft.getState()));
    if (!roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
    if (record.sessionId && isProjectSessionDeleted(record.sessionId)) {
        await releaseDeletedRoleConfigurationSession(record.id, record.sessionId);
        if (!roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
        router.navigate({ pathname: '/new', params: { roleConfiguration: record.id } } as never);
        return;
    }
    if (record.sessionId && !storage.getState().sessions[record.sessionId]) {
        // A missing cache row is not proof that the old conversation was deleted.
        await sync.ensureSessionHydrated(record.sessionId);
        if (!roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
    }
    const session = record.sessionId ? storage.getState().sessions[record.sessionId] : null;
    if (record.sessionId && (!session || session.metadata?.machineId !== record.machineId)) throw new Error(t('delegation.configurationUnavailable'));
    // A local association is a hint; only an accessible session on the same
    // machine can receive a draft. Deleted/foreign sessions never receive it.
    if (session && session.metadata?.machineId === record.machineId) {
        await flushDeviceStorageWrites();
        if (!roleConfigurationCurrent(record, owner) || storage.getState().sessions[session.id]?.metadata?.machineId !== record.machineId) throw new Error(t('delegation.configurationUnavailable'));
        const previous = storage.getState().sessions[session.id]?.draft ?? loadSessionDrafts()[session.id] ?? '';
        storage.getState().updateSessionDraft(session.id, appendRoleConfigurationPrompt(previous, record.input));
        await flushDeviceStorageWrites();
        if (!roleConfigurationCurrent(record, owner) || storage.getState().sessions[session.id]?.metadata?.machineId !== record.machineId) throw new Error(t('delegation.configurationUnavailable'));
        navigateToSession(router, session.id);
        return;
    }
    router.navigate({ pathname: '/new', params: { roleConfiguration: record.id } } as never);
}
