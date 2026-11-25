import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DelegationRoleManager } from '@/components/delegation/DelegationRoleManager';

export default React.memo(function DelegationRolesSettingsScreen() {
    const params = useLocalSearchParams<{ machineId?: string | string[] }>();
    const machineId = Array.isArray(params.machineId) ? params.machineId[0] : params.machineId;
    return <DelegationRoleManager initialMachineId={machineId} />;
});
