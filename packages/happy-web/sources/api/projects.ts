import { api } from './client';

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

export async function listProjects(): Promise<ProjectConfig[]> {
    const res = await api.get('/v1/projects');
    return res.data;
}

export async function getProject(id: string): Promise<ProjectConfig> {
    const res = await api.get(`/v1/projects/${id}`);
    return res.data.project;
}

export async function createProject(data: {
    name: string;
    description?: string | null;
    workingDirectory?: string | null;
    machineId?: string | null;
    githubUrl?: string | null;
    agentIds?: string[];
}): Promise<ProjectConfig> {
    const res = await api.post('/v1/projects', data);
    return res.data.project;
}

export async function updateProject(id: string, data: {
    name?: string;
    description?: string | null;
    workingDirectory?: string | null;
    machineId?: string | null;
    githubUrl?: string | null;
}): Promise<ProjectConfig> {
    const res = await api.post(`/v1/projects/${id}`, data);
    return res.data.project;
}

export async function addAgentToProject(projectId: string, agentId: string): Promise<void> {
    await api.post(`/v1/projects/${projectId}/agents`, { agentId });
}

export async function removeAgentFromProject(projectId: string, agentId: string): Promise<void> {
    await api.delete(`/v1/projects/${projectId}/agents/${agentId}`);
}

export async function deleteProject(id: string): Promise<void> {
    await api.delete(`/v1/projects/${id}`);
}
