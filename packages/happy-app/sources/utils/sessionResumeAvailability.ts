export type SessionResumeAvailability =
    | 'hidden'
    | 'missing-machine'
    | 'missing-backend-id'
    | 'wrong-machine'
    | 'machine-offline'
    | 'rpc-unavailable'
    | 'available';

export function resolveSessionResumeAvailability(input: {
    isConnected: boolean;
    hasFailedTurn: boolean;
    hasMachineId: boolean;
    hasBackendResumeId: boolean;
    hasMachine: boolean;
    machineOnline: boolean;
    rpcAvailable?: boolean;
}): SessionResumeAvailability {
    if (input.isConnected && !input.hasFailedTurn) return 'hidden';
    if (!input.hasMachineId) return 'missing-machine';
    if (!input.hasBackendResumeId) return 'missing-backend-id';
    if (!input.hasMachine) return 'wrong-machine';
    if (!input.machineOnline) return 'machine-offline';
    if (input.rpcAvailable === false) return 'rpc-unavailable';
    return 'available';
}
