import { api } from './client';

export interface MachineHostInfo {
    hostname?: string;
    ip?: string;
    platform?: string;
    arch?: string;
    agents?: string[];
    daemonPort?: number | null;
    workspaceRoot?: string | null;
}

export interface MachineInfo {
    id: string;
    displayName: string | null;
    hostInfo: MachineHostInfo | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

export async function listMachines(): Promise<MachineInfo[]> {
    const res = await api.get('/v1/machines');
    return res.data;
}

export async function updateMachine(id: string, data: { displayName?: string | null; hostInfo?: MachineHostInfo | null }): Promise<void> {
    await api.patch(`/v1/machines/${id}`, data);
}
