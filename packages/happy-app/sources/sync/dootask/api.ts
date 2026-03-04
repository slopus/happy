// packages/happy-app/sources/sync/dootask/api.ts

import type { CreateTaskParams, CreateProjectParams } from './types';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from '@/sync/serverConfig';

type LoginParams = {
    serverUrl: string;
    email: string;
    password: string;
    code?: string;
    codeKey?: string;
};

type LoginResult =
    | { type: 'success'; token: string; userId: number; username: string; avatar: string | null }
    | { type: 'captcha_required'; message: string }
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
        return { type: 'captcha_required', message: json.msg };
    }

    if (isTokenExpired(json)) {
        return { type: 'token_expired', message: json.msg };
    }

    return { type: 'error', message: json.msg || 'Login failed' };
}

export async function dootaskGetCaptcha(serverUrl: string): Promise<{ key: string; img: string }> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/users/login/codejson`, {
        method: 'GET',
        headers: buildHeaders(),
    });
    const json: DooTaskResponse = await response.json();
    return { key: json.data?.key ?? '', img: json.data?.img ?? '' };
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

export async function dootaskUpdateTask(serverUrl: string, token: string, params: { task_id: number; flow_item_id?: number; complete_at?: string | boolean; owner?: number[]; times?: [string, string] }): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/update`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(params),
    });
    return response.json();
}

// --- Chat ---

export async function dootaskFetchTaskDialog(serverUrl: string, token: string, taskId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/dialog?task_id=${taskId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchDialogOne(serverUrl: string, token: string, dialogId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/dialog/one?dialog_id=${dialogId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchDialogUsers(serverUrl: string, token: string, dialogId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/dialog/user?dialog_id=${dialogId}&getuser=1`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchDialogMessages(serverUrl: string, token: string, params: {
    dialog_id: number;
    prev_id?: number;
    next_id?: number;
    take?: number;
}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const qs = new URLSearchParams();
    qs.set('dialog_id', String(params.dialog_id));
    if (params.prev_id) qs.set('prev_id', String(params.prev_id));
    if (params.next_id) qs.set('next_id', String(params.next_id));
    if (params.take) qs.set('take', String(params.take));
    const response = await fetch(`${url}/api/dialog/msg/list?${qs}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskSendTextMessage(serverUrl: string, token: string, params: {
    dialog_id: number;
    text: string;
    reply_id?: number;
}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/dialog/msg/sendtext`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify({
            dialog_id: params.dialog_id,
            text: params.text,
            text_type: 'md',
            ...(params.reply_id ? { reply_id: params.reply_id } : {}),
        }),
    });
    return response.json();
}

export async function dootaskSendFileMessage(serverUrl: string, token: string, params: {
    dialog_id: number;
    image64: string;
    reply_id?: number;
}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const headers: Record<string, string> = {};
    if (token) headers['dootask-token'] = token;
    // multipart/form-data — let fetch set Content-Type with boundary
    const formData = new FormData();
    formData.append('dialog_id', String(params.dialog_id));
    formData.append('image64', params.image64);
    if (params.reply_id) formData.append('reply_id', String(params.reply_id));
    const response = await fetch(`${url}/api/dialog/msg/sendfile`, {
        method: 'POST',
        headers,
        body: formData,
    });
    return response.json();
}

/** Send a file (any type) by URI via the DooTask sendfile endpoint. */
export async function dootaskSendFileByUri(serverUrl: string, token: string, params: {
    dialog_id: number;
    fileUri: string;
    fileName: string;
    mimeType: string;
    reply_id?: number;
}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const headers: Record<string, string> = {};
    if (token) headers['dootask-token'] = token;
    const formData = new FormData();
    formData.append('dialog_id', String(params.dialog_id));
    // React Native FormData accepts { uri, name, type } objects for file uploads
    formData.append('files', {
        uri: params.fileUri,
        name: params.fileName,
        type: params.mimeType,
    } as any);
    if (params.reply_id) formData.append('reply_id', String(params.reply_id));
    const response = await fetch(`${url}/api/dialog/msg/sendfile`, {
        method: 'POST',
        headers,
        body: formData,
    });
    return response.json();
}

export async function dootaskToggleEmoji(serverUrl: string, token: string, params: {
    msg_id: number;
    symbol: string;
}): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/dialog/msg/emoji?msg_id=${params.msg_id}&symbol=${encodeURIComponent(params.symbol)}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

// --- Create ---

export async function dootaskFetchProjectColumns(serverUrl: string, token: string, projectId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/column/lists?project_id=${projectId}`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchProjectMembers(serverUrl: string, token: string, projectId: number): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/users/search?keys[project_id]=${projectId}&keys[bot]=0&keys[disable]=0&pagesize=100`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchPriorities(serverUrl: string, token: string): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/system/priority`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskFetchColumnTemplates(serverUrl: string, token: string): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/system/column/template`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    return response.json();
}

export async function dootaskCreateTask(serverUrl: string, token: string, params: CreateTaskParams): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/task/add`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(params),
    });
    return response.json();
}

export async function dootaskCreateProject(serverUrl: string, token: string, params: CreateProjectParams): Promise<DooTaskResponse> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/project/add`, {
        method: 'POST',
        headers: buildHeaders(token),
        body: JSON.stringify(params),
    });
    return response.json();
}

// --- Token Refresh ---

export async function dootaskRefreshToken(serverUrl: string, token: string): Promise<{ newToken: string | null; expiredAt: string | null; remainingSeconds: number | null }> {
    const url = validateServerUrl(serverUrl);
    const response = await fetch(`${url}/api/users/token/expire?refresh=1`, {
        method: 'GET',
        headers: buildHeaders(token),
    });
    const json: DooTaskResponse = await response.json();
    if (json.ret !== 1) {
        return { newToken: null, expiredAt: null, remainingSeconds: null };
    }
    return {
        newToken: json.data?.token ?? null,
        expiredAt: json.data?.expired_at ?? null,
        remainingSeconds: json.data?.remaining_seconds ?? null,
    };
}

// --- Happy Server Sync ---

type DootaskProfile = {
    serverUrl: string;
    token: string;
    userId: number;
    username: string;
    avatar: string | null;
};

/** Sync DooTask profile to Happy server */
export async function syncDootaskToServer(profile: DootaskProfile): Promise<void> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return;
    const endpoint = getServerUrl();
    await fetch(`${endpoint}/v1/connect/dootask`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credentials.token}`,
        },
        body: JSON.stringify(profile),
    });
}

/** Get DooTask profile from Happy server */
export async function getDootaskFromServer(): Promise<DootaskProfile | null> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return null;
    const endpoint = getServerUrl();
    const res = await fetch(`${endpoint}/v1/connect/dootask`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${credentials.token}` },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.profile ?? null;
}

/** Delete DooTask profile from Happy server */
export async function deleteDootaskFromServer(): Promise<void> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return;
    const endpoint = getServerUrl();
    await fetch(`${endpoint}/v1/connect/dootask`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${credentials.token}` },
    });
}
