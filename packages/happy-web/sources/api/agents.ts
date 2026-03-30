import { api } from './client';

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

export async function listAgents(): Promise<AgentConfig[]> {
    const res = await api.get('/v1/agents');
    return res.data;
}

export async function getAgent(id: string): Promise<AgentConfig> {
    const res = await api.get(`/v1/agents/${id}`);
    return res.data.agent;
}

export async function createAgent(data: {
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
    const res = await api.post('/v1/agents', data);
    return res.data.agent;
}

export async function updateAgent(id: string, data: Partial<Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>>): Promise<AgentConfig> {
    const res = await api.post(`/v1/agents/${id}`, data);
    return res.data.agent;
}

export async function deleteAgent(id: string): Promise<void> {
    await api.delete(`/v1/agents/${id}`);
}
