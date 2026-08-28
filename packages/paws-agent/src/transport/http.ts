import axios, { type AxiosInstance } from 'axios';
import { normalizeHttpError, PawsAgentError } from '../client/errors';
import type { CredentialProvider, PawsCredentials } from '../client/types';

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

    async get<T>(path: string): Promise<T> {
        return (await this.getWithCredentials<T>(path)).data;
    }

    async getWithCredentials<T>(path: string): Promise<{ data: T; credentials: PawsCredentials }> {
        try {
            const credentials = await this.getCredentials();
            const response = await this.client.get(this.url(path), {
                headers: this.headers(credentials),
                signal: this.abortController.signal,
            });
            return { data: response.data as T, credentials };
        } catch (error) {
            if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
            throw normalizeHttpError(error, `GET ${path}`);
        }
    }

    async post<T>(path: string, body: unknown): Promise<T> {
        try {
            const response = await this.client.post(this.url(path), body, {
                headers: this.headers(await this.getCredentials()),
                signal: this.abortController.signal,
            });
            return response.data as T;
        } catch (error) {
            if (this.disposed) throw new PawsAgentError('CONNECTION_LOST', 'HTTP transport disposed');
            throw normalizeHttpError(error, `POST ${path}`);
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
