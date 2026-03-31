import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

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

export type AgentStatus = 'working' | 'waiting' | 'done' | 'idle';

export interface ChatMessage {
    seq: number;
    role: 'user' | 'agent' | 'system';
    text: string;
    createdAt: number;
}

export interface ChatResponse {
    messages: ChatMessage[];
    agentStatus: AgentStatus;
}

export async function fetchTasks(credentials: AuthCredentials, projectId: string): Promise<TaskConfig[]> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${projectId}/tasks`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to fetch tasks: ${response.status}`);
        return await response.json() as TaskConfig[];
    });
}

export async function createTaskApi(credentials: AuthCredentials, projectId: string, data: {
    agentId: string;
    title: string;
    description?: string | null;
}): Promise<TaskConfig> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/projects/${projectId}/tasks`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) throw new Error(`Failed to create task: ${response.status}`);
        const json = await response.json();
        return json.task as TaskConfig;
    });
}

export async function runTaskApi(credentials: AuthCredentials, id: string, options?: { dangerouslySkipPermissions?: boolean }): Promise<{ happySessionId?: string; error?: string }> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/tasks/${id}/run`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(options || {})
        });
        if (!response.ok) throw new Error(`Failed to run task: ${response.status}`);
        const json = await response.json();
        return json.task || json;
    });
}

export async function updateTaskStatusApi(credentials: AuthCredentials, id: string, status: TaskStatus): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/tasks/${id}/status`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        if (!response.ok) throw new Error(`Failed to update task status: ${response.status}`);
    });
}

export async function deleteTaskApi(credentials: AuthCredentials, id: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/tasks/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to delete task: ${response.status}`);
    });
}

export async function fetchChatApi(credentials: AuthCredentials, taskId: string, afterSeq: number = 0): Promise<ChatResponse> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const params = new URLSearchParams({ after_seq: afterSeq.toString() });
        const response = await fetch(`${API_ENDPOINT}/v1/tasks/${taskId}/chat?${params}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${credentials.token}` }
        });
        if (!response.ok) throw new Error(`Failed to fetch chat: ${response.status}`);
        return await response.json() as ChatResponse;
    });
}

export async function sendChatApi(credentials: AuthCredentials, taskId: string, text: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/tasks/${taskId}/chat`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        if (!response.ok) throw new Error(`Failed to send chat: ${response.status}`);
    });
}
