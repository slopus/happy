import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

export interface ProjectAgentSummary {
    id: string;
    name: string;
    avatar: string | null;
    agentType: string;
}

export interface ProjectConfig {
    id: string;
    name: string;
    description: string | null;
    workingDirectory: string | null;
    machineId: string | null;
    githubUrl: string | null;
    agents: ProjectAgentSummary[];
    createdAt: number;
    updatedAt: number;
}

export async function fetchProjects(credentials: AuthCredentials): Promise<ProjectConfig[]> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to fetch projects: ${response.status}`);
        return await response.json() as ProjectConfig[];
    });
}

export async function createProjectApi(credentials: AuthCredentials, data: {
    name: string;
    description?: string | null;
    workingDirectory?: string | null;
    machineId?: string | null;
    githubUrl?: string | null;
    agentIds?: string[];
}): Promise<ProjectConfig> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Failed to create project: ${response.status}`);
        const json = await response.json();
        return json.project as ProjectConfig;
    });
}

export async function updateProjectApi(credentials: AuthCredentials, id: string, data: {
    name?: string;
    description?: string | null;
    workingDirectory?: string | null;
    machineId?: string | null;
    githubUrl?: string | null;
}): Promise<ProjectConfig> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Failed to update project: ${response.status}`);
        const json = await response.json();
        return json.project as ProjectConfig;
    });
}

export async function deleteProjectApi(credentials: AuthCredentials, id: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to delete project: ${response.status}`);
    });
}

export async function addAgentToProjectApi(credentials: AuthCredentials, projectId: string, agentId: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${projectId}/agents`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId })
        });
        if (!response.ok) throw new Error(`Failed to add agent to project: ${response.status}`);
    });
}

export async function removeAgentFromProjectApi(credentials: AuthCredentials, projectId: string, agentId: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${projectId}/agents/${agentId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to remove agent from project: ${response.status}`);
    });
}
