import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { findRoleConfigurationForSession, getRoleConfigurationVersion, readRoleConfiguration, subscribeRoleConfigurationChanges } from '@/sync/roleConfigurationHandoff';
import { returnToRoleConfigurationSettings } from '@/components/delegation/roleConfigurationNavigation';
import { useRoleFlowNavigationBack } from './useRoleFlowNavigationBack';

export function useRoleConfigurationReturn({ reference, machineId, sessionId, enabled = true, beforeReturn }: {
    reference?: string; machineId?: string; sessionId?: string; enabled?: boolean; beforeReturn?: () => void;
}) {
    const router = useRouter();
    React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    React.useSyncExternalStore(subscribeRoleConfigurationChanges, getRoleConfigurationVersion, getRoleConfigurationVersion);
    const record = reference ? readRoleConfiguration(reference) : machineId && sessionId ? findRoleConfigurationForSession(machineId, sessionId) : null;
    const recordId = record?.id;
    const back = React.useCallback(async () => {
        if (!recordId) return;
        try { beforeReturn?.(); await returnToRoleConfigurationSettings(router, recordId); }
        catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.retry')); }
    }, [router, recordId, beforeReturn]);
    useRoleFlowNavigationBack({ enabled: enabled && !!record, onBack: back });
    return enabled && record ? { back, reference: record.id } : null;
}
