import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

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

export async function fetchMachinesRest(credentials: AuthCredentials): Promise<MachineInfo[]> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/machines`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to fetch machines: ${response.status}`);
        return await response.json() as MachineInfo[];
    });
}

export async function updateMachineApi(credentials: AuthCredentials, id: string, data: { displayName?: string | null }): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/machines/${id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Failed to update machine: ${response.status}`);
    });
}
