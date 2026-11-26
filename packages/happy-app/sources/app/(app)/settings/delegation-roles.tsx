import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { DelegationRoleManager } from '@/components/delegation/DelegationRoleManager';

export default React.memo(function DelegationRolesSettingsScreen() {
    const params = useLocalSearchParams<{ machineId?: string | string[]; roleId?: string | string[] }>();
    const machineId = Array.isArray(params.machineId) ? params.machineId[0] : params.machineId;
    const roleId = Array.isArray(params.roleId) ? params.roleId[0] : params.roleId;
    return <DelegationRoleManager initialMachineId={machineId} initialRoleId={roleId} />;
});
