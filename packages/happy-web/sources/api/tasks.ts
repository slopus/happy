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
    error?: string;
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

export async function runTask(id: string, options?: { dangerouslySkipPermissions?: boolean }): Promise<{ happySessionId?: string; error?: string }> {
    const res = await api.post(`/v1/tasks/${id}/run`, options || {});
    return res.data.task || res.data;
}

export interface ChatMessage {
    seq: number;
    role: 'user' | 'agent' | 'system';
    text: string;
    createdAt: number;
}

export type AgentStatus = 'working' | 'waiting' | 'done' | 'idle';

export interface ChatResponse {
    messages: ChatMessage[];
    agentStatus: AgentStatus;
}

export async function fetchChat(taskId: string, afterSeq: number = 0): Promise<ChatResponse> {
    const res = await api.get(`/v1/tasks/${taskId}/chat`, { params: { after_seq: afterSeq } });
    return res.data;
}

export async function sendChat(taskId: string, text: string): Promise<void> {
    await api.post(`/v1/tasks/${taskId}/chat`, { text });
}

export async function deleteTask(id: string): Promise<void> {
    await api.delete(`/v1/tasks/${id}`);
}
