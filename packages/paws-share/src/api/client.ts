import type { PublicSessionSnapshot, PublicSessionSourceProvider } from '@slopus/happy-wire';

export type CreateDraftResult = {
    shareId: string;
    generation: string;
    publicId: string;
    publicUrl: string;
    expiresAt: string;
};

export type UploadAsset = {
    attachmentId: string;
    name: string;
    mimeType: string;
    kind: 'image' | 'audio' | 'video' | 'file';
    size: number;
    sha256: string;
    bytes: Uint8Array;
};

export type ManagedShareStatus = {
    shareId: string;
    publicId: string;
    active: boolean;
    revoked: boolean;
    publishedAt: string | null;
    expiresAt: string | null;
    sourceProvider: PublicSessionSourceProvider;
};

export class PawsShareApiError extends Error {
    constructor(readonly statusCode: number) {
        super(`Paws Share request failed (${statusCode})`);
    }
}

export type PawsShareClientOptions = {
    serverUrl: string;
    token: string;
    fetch?: typeof globalThis.fetch;
    retryDelayMs?: number;
};

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost'
        || hostname === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function trustedServerOrigin(value: string): string {
    let server: URL;
    try {
        server = new URL(value);
    } catch {
        throw new Error('Paws Share server URL is invalid');
    }
    if (server.username || server.password || server.search || server.hash || (server.pathname !== '/' && server.pathname !== '')) {
        throw new Error('Paws Share server URL must contain only a trusted origin');
    }
    if (server.protocol !== 'https:' && !(server.protocol === 'http:' && isLoopbackHost(server.hostname))) {
        throw new Error('Paws Share server URL must use HTTPS (HTTP is allowed only for loopback development)');
    }
    return server.origin;
}

export class PawsShareClient {
    private readonly serverUrl: string;
    private readonly token: string;
    private readonly fetchImplementation: typeof globalThis.fetch;
    private readonly retryDelayMs: number;

    constructor(options: PawsShareClientOptions) {
        this.serverUrl = trustedServerOrigin(options.serverUrl);
        this.token = options.token;
        this.fetchImplementation = options.fetch ?? globalThis.fetch;
        this.retryDelayMs = options.retryDelayMs ?? 250;
    }

    async createDraft(sourceProvider: PublicSessionSourceProvider, requestId: string): Promise<CreateDraftResult> {
        return this.request('/v1/external/session-shares/drafts', {
            method: 'POST',
            headers: { 'Idempotency-Key': requestId },
            body: JSON.stringify({ sourceProvider }),
        });
    }

    async createReplacementDraft(shareId: string): Promise<{ generation: string; publicId: string }> {
        return this.request(`/v1/external/session-shares/${encodeURIComponent(shareId)}/drafts`, {
            method: 'POST',
        });
    }

    async prepareAndUploadAsset(shareId: string, generation: string, asset: UploadAsset): Promise<void> {
        const prepared = await this.request<{ uploadUrl: string }>(
            `/v1/external/session-shares/${encodeURIComponent(shareId)}/drafts/${encodeURIComponent(generation)}/assets`,
            {
                method: 'POST',
                body: JSON.stringify({
                    attachmentId: asset.attachmentId,
                    name: asset.name,
                    mimeType: asset.mimeType,
                    kind: asset.kind,
                    size: asset.size,
                    sha256: asset.sha256,
                }),
            },
        );
        await this.request(this.normalizeUploadUrl(prepared.uploadUrl), {
            method: 'PUT',
            body: asset.bytes,
            headers: { 'Content-Type': 'application/octet-stream' },
        });
    }

    async publish(shareId: string, generation: string, snapshot: PublicSessionSnapshot): Promise<{ publicId: string; publishedAt: number }> {
        return this.request(
            `/v1/external/session-shares/${encodeURIComponent(shareId)}/drafts/${encodeURIComponent(generation)}/publish`,
            { method: 'PUT', body: JSON.stringify({ snapshot }) },
        );
    }

    async status(shareId: string): Promise<ManagedShareStatus> {
        return this.request(`/v1/external/session-shares/${encodeURIComponent(shareId)}`, { method: 'GET' });
    }

    async renew(shareId: string): Promise<{ expiresAt: string }> {
        return this.request(`/v1/external/session-shares/${encodeURIComponent(shareId)}/renew`, { method: 'POST' });
    }

    async revoke(shareId: string): Promise<{ ok: true }> {
        return this.request(`/v1/external/session-shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
    }

    private normalizeUploadUrl(value: string): string {
        const upload = new URL(value, `${this.serverUrl}/`);
        const server = new URL(this.serverUrl);
        if (upload.origin !== server.origin || upload.username || upload.password || upload.hash) {
            throw new Error('Paws Share server returned an untrusted upload URL');
        }
        return `${upload.pathname}${upload.search}`;
    }

    private async request<T>(pathOrUrl: string, init: RequestInit): Promise<T> {
        const requestUrl = new URL(pathOrUrl, `${this.serverUrl}/`);
        if (requestUrl.origin !== this.serverUrl || requestUrl.username || requestUrl.password || requestUrl.hash) {
            throw new Error('Paws Share request URL is outside the trusted server origin');
        }
        const url = requestUrl.toString();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `PawsShare ${this.token}`);
        if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

        for (let attempt = 0; attempt < 3; attempt += 1) {
            let response: Response;
            try {
                response = await this.fetchImplementation(url, { ...init, headers, redirect: 'error' });
            } catch (error) {
                if (attempt === 2) throw new PawsShareApiError(0);
                await this.delay(attempt);
                continue;
            }
            if (response.ok) {
                const text = await response.text();
                return (text ? JSON.parse(text) : {}) as T;
            }
            if (response.status >= 500 && attempt < 2) {
                await response.arrayBuffer().catch(() => undefined);
                await this.delay(attempt);
                continue;
            }
            await response.arrayBuffer().catch(() => undefined);
            throw new PawsShareApiError(response.status);
        }
        throw new PawsShareApiError(0);
    }

    private async delay(attempt: number): Promise<void> {
        const milliseconds = this.retryDelayMs * 2 ** attempt;
        if (milliseconds <= 0) return;
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}
