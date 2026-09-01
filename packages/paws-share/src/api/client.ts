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

export class PawsShareClient {
    private readonly serverUrl: string;
    private readonly token: string;
    private readonly fetchImplementation: typeof globalThis.fetch;
    private readonly retryDelayMs: number;

    constructor(options: PawsShareClientOptions) {
        this.serverUrl = options.serverUrl.replace(/\/$/, '');
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
        const upload = new URL(value, this.serverUrl);
        const server = new URL(this.serverUrl);
        if ((upload.hostname === 'localhost' || upload.hostname === '127.0.0.1')
            && upload.hostname !== server.hostname) {
            return new URL(`${upload.pathname}${upload.search}`, server).toString();
        }
        return upload.toString();
    }

    private async request<T>(pathOrUrl: string, init: RequestInit): Promise<T> {
        const url = new URL(pathOrUrl, `${this.serverUrl}/`).toString();
        const headers = new Headers(init.headers);
        headers.set('Authorization', `PawsShare ${this.token}`);
        if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

        for (let attempt = 0; attempt < 3; attempt += 1) {
            let response: Response;
            try {
                response = await this.fetchImplementation(url, { ...init, headers });
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
