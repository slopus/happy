import type { Router } from 'expo-router';
import { flushDeviceStorageWrites } from '@/persistence/deviceStorage';
import { navigateToSession } from '@/hooks/useNavigateToSession';
import { useNewSessionDraft, newSessionDraftSnapshot } from '@/hooks/useNewSessionDraft';
import { storage } from '@/sync/storage';
import { createRoleConfiguration, readRoleConfiguration, roleConfigurationCurrent, releaseDeletedRoleConfigurationSession, type RoleConfigurationRequest } from '@/sync/roleConfigurationHandoff';
import { t } from '@/text';
import { getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { isProjectSessionDeleted } from '@/sync/projectSessionLinks';
import { sync } from '@/sync/sync';

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
        navigateToSession(router, session.id, { roleConfigurationId: record.id });
        return;
    }
    router.navigate({ pathname: '/new', params: { roleConfiguration: record.id } } as never);
}

/** Explicit return survives the normal session stack compaction and page reload. */
export async function returnToRoleConfigurationSettings(router: Router, reference: string) {
    const owner = getFirstSubmissionScope();
    const record = readRoleConfiguration(reference);
    if (!record || !roleConfigurationCurrent(record, owner)) throw new Error(t('delegation.configurationUnavailable'));
    await flushDeviceStorageWrites();
    const latest = readRoleConfiguration(reference);
    if (!latest || !roleConfigurationCurrent(latest, owner)) throw new Error(t('delegation.configurationUnavailable'));
    router.navigate({ pathname: '/settings/delegation-roles', params: {
        machineId: latest.machineId, roleConfigurationReturn: latest.id,
        ...(latest.savedRole ? { roleId: latest.roleId } : {}),
        ...(latest.returnContext?.desktopModal ? { desktopModal: '1' } : {}),
    } } as never);
}
