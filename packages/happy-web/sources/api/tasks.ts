import { api } from './client';

export type TaskStatus = 'running' | 'waiting_for_permission' | 'done' | 'failed';

export interface TaskAgentSummary {
    id: string;
    name: string;
    avatar: string | null;
    agentType: string;
}

export interface TaskConfig {
    id: string;
    projectId: string;
    title: string;
    description: string | null;
    status: TaskStatus;
    happySessionId: string | null;
    agent: TaskAgentSummary;
    createdAt: number;
    updatedAt: number;
    finishedAt: number | null;
}

export async function listTasks(projectId: string): Promise<TaskConfig[]> {
    const res = await api.get(`/v1/projects/${projectId}/tasks`);
    return res.data;
}

export async function getTask(id: string): Promise<TaskConfig> {
    const res = await api.get(`/v1/tasks/${id}`);
    return res.data.task;
}

export async function createTask(projectId: string, data: {
    agentId: string;
    title: string;
    description?: string | null;
}): Promise<TaskConfig> {
    const res = await api.post(`/v1/projects/${projectId}/tasks`, data);
    return res.data.task;
}

export async function updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
    await api.post(`/v1/tasks/${id}/status`, { status });
}

export async function deleteTask(id: string): Promise<void> {
    await api.delete(`/v1/tasks/${id}`);
}
