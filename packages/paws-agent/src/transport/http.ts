import axios, { type AxiosInstance } from 'axios';
import { normalizeHttpError, PawsAgentError } from '../client/errors';
import type { CredentialProvider, PawsCredentials } from '../client/types';
import { parseAttachmentUpload } from './attachmentUpload';

const COMPATIBILITY_CLIENT = 'paws-agent-sdk/0.1.0';

export class PawsHttpTransport {
    private readonly serverUrl: string;
    private readonly credentials: CredentialProvider;
    private readonly client: AxiosInstance;
    private readonly abortController = new AbortController();
    private disposed = false;

    constructor(options: {
        serverUrl: string;
        credentials: CredentialProvider;
        client?: AxiosInstance;
    }) {
        const serverUrl = options.serverUrl.trim().replace(/\/+$/, '');
        if (!serverUrl) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'serverUrl is required');
        }
        this.serverUrl = serverUrl;
        this.credentials = options.credentials;
        this.client = options.client ?? axios;
    }

    async getCredentials(): Promise<PawsCredentials> {
        this.ensureActive();
        const credentials = await this.credentials.getCredentials();
        if (!credentials) {
            throw new PawsAgentError('AUTH_REQUIRED', 'Authentication required');
        }
        return credentials;
    }

    async get<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> {
        return (await this.getWithCredentials<T>(path, options)).data;
    }

    async getWithCredentials<T>(path: string, options: { signal?: AbortSignal } = {}): Promise<{ data: T; credentials: PawsCredentials }> {
        const signal = options.signal ? AbortSignal.any([options.signal, this.abortController.signal]) : this.abortController.signal;
        try {
            signal.throwIfAborted();
            const credentials = await this.getCredentials();
            signal.throwIfAborted();
            const response = await this.client.get(this.url(path), {
                headers: this.headers(credentials),
                signal,
            });
            return { data: response.data as T, credentials };
        } catch (error) {
            if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
            if (signal.aborted) throw new PawsAgentError('CONNECTION_LOST', 'Request cancelled');
            throw normalizeHttpError(error, `GET ${path}`);
        }
    }

    async post<T>(path: string, body: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
        const signal = options.signal
            ? AbortSignal.any([options.signal, this.abortController.signal])
            : this.abortController.signal;
        try {
            signal.throwIfAborted();
            const credentials = await this.getCredentials();
            signal.throwIfAborted();
            const response = await this.client.post(this.url(path), body, {
                headers: this.headers(credentials),
                signal,
            });
            return response.data as T;
        } catch (error) {
            if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
            if (signal.aborted) throw new PawsAgentError('CONNECTION_LOST', 'Request cancelled');
            throw normalizeHttpError(error, `POST ${path}`);
        }
    }

    async uploadAttachment(value: unknown, bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<string> {
        this.ensureActive();
        const upload = parseAttachmentUpload(value, this.serverUrl);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 15_000);
        const signal = AbortSignal.any([this.abortController.signal, timeout.signal, ...(options.signal ? [options.signal] : [])]);
        try {
            signal.throwIfAborted();
            const headers: Record<string, string> = {};
            let body: Blob | FormData = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
            if (upload.method === 'POST') {
                const form = new FormData();
                for (const [name, value] of Object.entries(upload.formFields ?? {})) form.append(name, value);
                form.append('file', body, 'blob');
                body = form;
            } else {
                headers['Content-Type'] = 'application/octet-stream';
                // 不能用 startsWith 判定归属，否则相似域名会获得 Paws token。
                if (new URL(upload.uploadUrl).origin === new URL(this.serverUrl).origin) {
                    headers.Authorization = `Bearer ${(await this.getCredentials()).token}`;
                }
            }
            signal.throwIfAborted();
            const response = await fetch(upload.uploadUrl, {
                method: upload.method, headers, body, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
            });
            signal.throwIfAborted();
            if (!response.ok) throw new PawsAgentError('UNKNOWN', 'Attachment upload failed', { details: { status: response.status } });
            return upload.ref;
        } catch (error) {
            if (this.disposed || options.signal?.aborted) throw new PawsAgentError('CONNECTION_LOST', 'Attachment upload cancelled');
            if (timeout.signal.aborted) throw new PawsAgentError('RPC_TIMEOUT', 'Attachment upload timed out');
            // 不把带签名的对象存储 URL 放进错误详情。
            if (error instanceof PawsAgentError) throw error;
            throw new PawsAgentError('UNKNOWN', 'Attachment upload failed');
        } finally {
            clearTimeout(timer);
        }
    }

    async delete(path: string): Promise<void> {
        try {
            await this.client.delete(this.url(path), {
                headers: this.headers(await this.getCredentials()),
                signal: this.abortController.signal,
            });
        } catch (error) {
            if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
            throw normalizeHttpError(error, `DELETE ${path}`);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.abortController.abort();
    }

    private url(path: string): string {
        if (!path.startsWith('/')) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'HTTP path must start with /');
        }
        return this.serverUrl + path;
    }

    private headers(credentials: PawsCredentials): Record<string, string> {
        return {
            Authorization: `Bearer ${credentials.token}`,
            'X-Happy-Client': COMPATIBILITY_CLIENT,
        };
    }

    private ensureActive(): void {
        if (this.disposed) {
            throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
        }
    }
}
