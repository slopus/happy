// packages/happy-app/sources/sync/dootask/api.ts

type LoginParams = {
    serverUrl: string;
    email: string;
    password: string;
    code?: string;
    codeKey?: string;
};

type LoginResult =
    | { type: 'success'; token: string; userId: number; username: string; avatar: string | null }
    | { type: 'captcha_required'; message: string; codeKey: string }
    | { type: 'error'; message: string }
    | { type: 'token_expired'; message: string };

export type DooTaskResponse<T = any> = { ret: number; msg: string; data: T };

function buildHeaders(token?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['dootask-token'] = token;
    return h;
}

export function isTokenExpired(res: DooTaskResponse): boolean {
    return res.ret === -1 || /身份已失效|请登录后继续/.test(res.msg);
}

function validateServerUrl(url: string): string {
    const trimmed = url.replace(/\/+$/, '');
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
        throw new Error('Server URL must use HTTPS');
    }
    return trimmed;
}

// --- Auth ---

export async function dootaskLogin(params: LoginParams): Promise<LoginResult> {
    const url = validateServerUrl(params.serverUrl);
    const body: Record<string, string> = { email: params.email, password: params.password };
    if (params.code) body.code = params.code;
    if (params.codeKey) body.code_key = params.codeKey;

    const response = await fetch(`${url}/api/users/login`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body),
    });

    const json: DooTaskResponse = await response.json();

    if (json.ret === 1) {
        return {
            type: 'success',
            token: json.data.token,
            userId: json.data.userid,
            username: json.data.nickname || json.data.email,
            avatar: json.data.userimg || null,
        };
    }

    if (json.ret === 0 && json.data?.code === 'need') {
        const codeKey = json.data.code_key;
        if (!codeKey) {
            return { type: 'error', message: json.msg || 'Captcha required but server returned invalid response' };
        }
        return { type: 'captcha_required', message: json.msg, codeKey };
    }

    if (isTokenExpired(json)) {
        return { type: 'token_expired', message: json.msg };
    }

    return { type: 'error', message: json.msg || 'Login failed' };
}

export async function dootaskGetTokenExpire(serverUrl: string, token: string): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/users/token/expire`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskLogout(serverUrl: string, token: string): Promise<void> {
    const url = validateServerUrl(serverUrl);
    await fetch(`${url}/api/users/logout`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
}

// --- Data ---

type FetchTasksParams = {
    page: number;
    pagesize: number;
    project_id?: number;
    parent_id?: number;
    keys?: Record<string, string>;
    time?: string;
    timerange?: string;
    owner?: number;
    with_extend?: string;
};

export async function dootaskFetchProjects(serverUrl: string, token: string, params: { page?: number; pagesize?: number; keys?: Record<string, string> } = {}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pagesize) qs.set('pagesize', String(params.pagesize));
    if (params.keys) {
        for (const [k, v] of Object.entries(params.keys)) {
            qs.set(`keys[${k}]`, v);
        }
    }
    const response = await fetch(`${url}/api/project/lists?${qs}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchTasks(serverUrl: string, token: string, params: FetchTasksParams): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const qs = new URLSearchParams();
    qs.set('page', String(params.page));
    qs.set('pagesize', String(params.pagesize));
    if (params.project_id) qs.set('project_id', String(params.project_id));
    if (params.parent_id !== undefined) qs.set('parent_id', String(params.parent_id));
    if (params.time) qs.set('time', params.time);
    if (params.timerange) qs.set('timerange', params.timerange);
    if (params.owner !== undefined) qs.set('owner', String(params.owner));
    if (params.with_extend) qs.set('with_extend', params.with_extend);
    if (params.keys) {
        for (const [k, v] of Object.entries(params.keys)) {
            qs.set(`keys[${k}]`, v);
        }
    }
    const response = await fetch(`${url}/api/project/task/lists?${qs}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchTaskDetail(serverUrl: string, token: string, taskId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/one?task_id=${taskId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchUsersBasic(serverUrl: string, token: string, userIds: number[]): Promise<DooTaskResponse> {
    if (userIds.length === 0) return { ret: 1, msg: '', data: [] };
    const url = validateServerUrl(serverUrl);
    const qs = new URLSearchParams({ userid: JSON.stringify(userIds) });
    const response = await fetch(`${url}/api/users/basic?${qs}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchTaskContent(serverUrl: string, token: string, taskId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/content`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({ task_id: taskId }),
    });
    return response.json();
}

export async function dootaskFetchTaskFlow(serverUrl: string, token: string, taskId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/flow?task_id=${taskId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchSubTasks(serverUrl: string, token: string, parentId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const qs = new URLSearchParams({ parent_id: String(parentId), page: '1', pagesize: '100' });
    const response = await fetch(`${url}/api/project/task/lists?${qs}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchTaskFiles(serverUrl: string, token: string, taskId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/files?task_id=${taskId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskUpdateTask(serverUrl: string, token: string, params: { task_id: number; flow_item_id?: number; complete_at?: string | boolean }): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/update`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(params),
    });
    return response.json();
}
