import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

export type OrchestratorRunStatus = 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled';
export type OrchestratorTaskStatus = 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'dependency_failed';
export type OrchestratorExecutionStatus = 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type OrchestratorSessionActivity = Record<string, string[]>;

export type OrchestratorRunSummary = {
    total: number;
    queued: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
};

export type OrchestratorExecutionRecord = {
    executionId: string;
    attempt: number;
    status: OrchestratorExecutionStatus;
    machineId: string;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    signal: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    outputSummary: string | null;
    createdAt: string;
    updatedAt: string;
};

export type OrchestratorTaskRecord = {
    taskId: string;
    seq: number;
    taskKey: string | null;
    title: string | null;
    status: OrchestratorTaskStatus;
    provider: 'claude' | 'codex' | 'gemini';
    model: string | null;
    workingDirectory: string | null;
    dependsOn: string[];
    retry: {
        maxAttempts: number;
        backoffMs: number;
    };
    nextAttemptAt: string | null;
    outputSummary: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    executions?: OrchestratorExecutionRecord[];
};

export type OrchestratorRunDetail = {
    runId: string;
    title: string;
    status: OrchestratorRunStatus;
    maxConcurrency: number;
    controllerSessionId: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    cancelRequestedAt: string | null;
    summary: OrchestratorRunSummary;
    machines?: string[];
    tasks?: OrchestratorTaskRecord[];
};

export type OrchestratorTaskDetail = {
    run: {
        runId: string;
        title: string;
        status: OrchestratorRunStatus;
        updatedAt: string;
    };
    task: OrchestratorTaskRecord;
};

type ApiErrorBody = {
    ok?: boolean;
    error?: {
        message?: string;
    };
};

function buildAuthHeaders(credentials: AuthCredentials): Record<string, string> {
    return {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
    };
}

async function readErrorMessage(response: Response): Promise<string> {
    try {
        const body = await response.json() as ApiErrorBody;
        return body?.error?.message || `Request failed: ${response.status}`;
    } catch (_error) {
        return `Request failed: ${response.status}`;
    }
}

export type ListOrchestratorRunsQuery = {
    status?: 'active' | 'terminal' | OrchestratorRunStatus;
    limit?: number;
    cursor?: string;
    controllerSessionId?: string;
};

export async function listOrchestratorRuns(
    credentials: AuthCredentials,
    query: ListOrchestratorRunsQuery = {},
): Promise<{ items: Array<Pick<OrchestratorRunDetail, 'runId' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'summary'> & { machines?: string[]; }>; nextCursor?: string; }> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.controllerSessionId) params.set('controllerSessionId', query.controllerSessionId);
    const queryString = params.toString();

    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/runs${queryString ? `?${queryString}` : ''}`, {
            headers: buildAuthHeaders(credentials),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const body = await response.json() as {
            ok: true;
            data: {
                items: Array<Pick<OrchestratorRunDetail, 'runId' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'summary'> & { machines?: string[]; }>;
                nextCursor?: string;
            };
        };
        return body.data;
    });
}

export type OrchestratorRunCounts = Record<string, number>;

export async function getOrchestratorRunCounts(
    credentials: AuthCredentials,
    controllerSessionId?: string,
): Promise<OrchestratorRunCounts> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams();
    if (controllerSessionId) params.set('controllerSessionId', controllerSessionId);
    const queryString = params.toString();

    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/runs/counts${queryString ? `?${queryString}` : ''}`, {
            headers: buildAuthHeaders(credentials),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const body = await response.json() as { ok: true; data: OrchestratorRunCounts };
        return body.data;
    });
}

export type GetOrchestratorRunQuery = {
    includeTasks?: boolean;
    includeExecutions?: boolean;
};

export async function getOrchestratorRun(
    credentials: AuthCredentials,
    runId: string,
    query: GetOrchestratorRunQuery = {},
): Promise<OrchestratorRunDetail> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams();
    params.set('includeTasks', String(query.includeTasks ?? true));
    if ((query.includeTasks ?? true) && query.includeExecutions) {
        params.set('includeExecutions', 'true');
    }

    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/runs/${encodeURIComponent(runId)}?${params.toString()}`, {
            headers: buildAuthHeaders(credentials),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const body = await response.json() as { ok: true; data: OrchestratorRunDetail };
        return body.data;
    });
}

export async function pendOrchestratorRun(
    credentials: AuthCredentials,
    runId: string,
    query: {
        cursor?: string;
        waitFor?: 'change' | 'terminal';
        timeoutMs?: number;
        include?: 'summary' | 'all_tasks';
    } = {},
    options?: {
        signal?: AbortSignal;
    },
): Promise<{
    runId: string;
    terminal: boolean;
    changed: boolean;
    cursor: string;
    run: {
        status: OrchestratorRunStatus;
        summary: OrchestratorRunSummary;
        updatedAt: string;
    };
    tasks?: OrchestratorTaskRecord[];
}> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.waitFor) params.set('waitFor', query.waitFor);
    if (typeof query.timeoutMs === 'number') params.set('timeoutMs', String(query.timeoutMs));
    if (query.include) params.set('include', query.include);

    const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/runs/${encodeURIComponent(runId)}/pend?${params.toString()}`, {
        headers: buildAuthHeaders(credentials),
        signal: options?.signal,
    });
    if (!response.ok) {
        throw new Error(await readErrorMessage(response));
    }
    const body = await response.json() as {
        ok: true;
        data: {
            runId: string;
            terminal: boolean;
            changed: boolean;
            cursor: string;
            run: {
                status: OrchestratorRunStatus;
                summary: OrchestratorRunSummary;
                updatedAt: string;
            };
            tasks?: OrchestratorTaskRecord[];
        };
    };
    return body.data;
}

export type GetOrchestratorTaskQuery = {
    includeExecutions?: boolean;
};

export async function getOrchestratorTask(
    credentials: AuthCredentials,
    runId: string,
    taskId: string,
    query: GetOrchestratorTaskQuery = {},
): Promise<OrchestratorTaskDetail> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams();
    if (query.includeExecutions) {
        params.set('includeExecutions', 'true');
    }
    const queryString = params.toString();

    return backoff(async () => {
        const response = await fetch(
            `${API_ENDPOINT}/v1/orchestrator/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}${queryString ? `?${queryString}` : ''}`,
            {
                headers: buildAuthHeaders(credentials),
            },
        );
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const body = await response.json() as { ok: true; data: OrchestratorTaskDetail };
        return body.data;
    });
}

export async function cancelOrchestratorRun(
    credentials: AuthCredentials,
    runId: string,
    reason?: string,
): Promise<{ runId: string; status: OrchestratorRunStatus; accepted: boolean; }> {
    const API_ENDPOINT = getServerUrl();
    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/runs/${encodeURIComponent(runId)}/cancel`, {
            method: 'POST',
            headers: buildAuthHeaders(credentials),
            body: JSON.stringify(reason ? { reason } : {}),
        });
        if (!response.ok) {
            throw new Error(await readErrorMessage(response));
        }
        const body = await response.json() as {
            ok: true;
            data: {
                runId: string;
                status: OrchestratorRunStatus;
                accepted: boolean;
            };
        };
        return body.data;
    });
}

export async function getOrchestratorActivity(
    credentials: AuthCredentials,
    controllerSessionId: string,
): Promise<{ activity: OrchestratorSessionActivity }> {
    const API_ENDPOINT = getServerUrl();
    const params = new URLSearchParams({ controllerSessionId });

    const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/activity?${params.toString()}`, {
        headers: buildAuthHeaders(credentials),
    });
    if (!response.ok) {
        throw new Error(await readErrorMessage(response));
    }
    const body = await response.json() as { ok: true; data: { activity: OrchestratorSessionActivity } };
    return body.data;
}

export async function getOrchestratorActivityBatch(
    credentials: AuthCredentials,
): Promise<{ activity: Record<string, OrchestratorSessionActivity> }> {
    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v1/orchestrator/activity/batch`, {
        headers: buildAuthHeaders(credentials),
    });
    if (!response.ok) {
        throw new Error(await readErrorMessage(response));
    }
    const body = await response.json() as { ok: true; data: { activity: Record<string, OrchestratorSessionActivity> } };
    return body.data;
}
