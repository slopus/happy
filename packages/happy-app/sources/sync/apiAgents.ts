import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

export interface AgentConfig {
    id: string;
    name: string;
    avatar: string | null;
    agentType: string;
    systemPrompt: string | null;
    model: string | null;
    permissionMode: string | null;
    allowedTools: string[] | null;
    disallowedTools: string[] | null;
    mcpServers: any | null;
    environmentVariables: Record<string, string> | null;
    maxTurns: number | null;
    autoTerminate: boolean;
    createdAt: number;
    updatedAt: number;
}

export async function fetchAgents(credentials: AuthCredentials): Promise<AgentConfig[]> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/agents`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to fetch agents: ${response.status}`);
        return await response.json() as AgentConfig[];
    });
}

export async function createAgentApi(credentials: AuthCredentials, data: {
    name: string;
    agentType: string;
    avatar?: string | null;
    systemPrompt?: string | null;
    model?: string | null;
    permissionMode?: string | null;
    allowedTools?: string[] | null;
    disallowedTools?: string[] | null;
    mcpServers?: any;
    environmentVariables?: Record<string, string> | null;
    maxTurns?: number | null;
    autoTerminate?: boolean;
}): Promise<AgentConfig> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/agents`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Failed to create agent: ${response.status}`);
        const json = await response.json();
        return json.agent as AgentConfig;
    });
}

export async function deleteAgentApi(credentials: AuthCredentials, id: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/agents/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to delete agent: ${response.status}`);
    });
}
