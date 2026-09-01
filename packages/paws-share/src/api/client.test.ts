import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { PawsShareApiError, PawsShareClient } from './client';

type CapturedRequest = {
    method: string;
    url: string;
    authorization?: string;
    idempotencyKey?: string;
    body: Buffer;
};

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
        server.close();
        await once(server, 'close');
    }));
});

async function body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function testServer(handler: (request: CapturedRequest, response: ServerResponse) => void | Promise<void>) {
    const server = createServer(async (request, response) => {
        await handler({
            method: request.method ?? 'GET',
            url: request.url ?? '/',
            authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
            idempotencyKey: typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : undefined,
            body: await body(request),
        }, response);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
}

const token = Buffer.alloc(32, 7).toString('base64url');
const requestId = '11111111-1111-4111-8111-111111111111';
const attachmentId = '22222222-2222-4222-8222-222222222222';

describe('PawsShareClient', () => {
    it('publishes assets in prepare-upload-publish order with capability and idempotency headers', async () => {
        const requests: CapturedRequest[] = [];
        let origin = '';
        origin = await testServer((request, response) => {
            requests.push(request);
            if (request.url === '/v1/external/session-shares/drafts') {
                return json(response, 200, {
                    shareId: 'share-1', generation: 'generation-1', publicId: 'public-1',
                    publicUrl: `${origin}/share/public-1`, expiresAt: '2026-11-30T00:00:00.000Z',
                });
            }
            if (request.url.endsWith('/assets') && request.method === 'POST') {
                return json(response, 200, {
                    assetId: attachmentId,
                    method: 'PUT',
                    uploadUrl: `${origin}/v1/external/session-shares/share-1/drafts/generation-1/assets/${attachmentId}`,
                });
            }
            if (request.url.endsWith(`/assets/${attachmentId}`) && request.method === 'PUT') return json(response, 200, { ok: true });
            if (request.url.endsWith('/publish') && request.method === 'PUT') return json(response, 200, { publicId: 'public-1', publishedAt: 1_788_192_000_000 });
            return json(response, 404, { error: 'missing' });
        });
        const client = new PawsShareClient({ serverUrl: origin, token, retryDelayMs: 0 });

        const draft = await client.createDraft('codex', requestId);
        await client.prepareAndUploadAsset(draft.shareId, draft.generation, {
            attachmentId,
            name: 'attachment.svg',
            mimeType: 'image/svg+xml',
            kind: 'image',
            size: 5,
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
            bytes: Buffer.from('hello'),
        });
        await client.publish(draft.shareId, draft.generation, {
            version: 1,
            title: 'Drawing',
            sharedAt: 1_788_192_000_000,
            source: { provider: 'codex' },
            messages: [],
        });

        expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
            'POST /v1/external/session-shares/drafts',
            'POST /v1/external/session-shares/share-1/drafts/generation-1/assets',
            `PUT /v1/external/session-shares/share-1/drafts/generation-1/assets/${attachmentId}`,
            'PUT /v1/external/session-shares/share-1/drafts/generation-1/publish',
        ]);
        expect(requests.every((request) => request.authorization === `PawsShare ${token}`)).toBe(true);
        expect(requests[0].idempotencyKey).toBe(requestId);
        expect(requests[2].body.toString()).toBe('hello');
    });

    it('retries an idempotent create request after a transient server failure', async () => {
        let attempts = 0;
        const origin = await testServer((_request, response) => {
            attempts += 1;
            if (attempts === 1) return json(response, 503, { error: 'temporarily unavailable' });
            return json(response, 200, {
                shareId: 'share-1', generation: 'generation-1', publicId: 'public-1',
                publicUrl: 'https://paws.test/share/public-1', expiresAt: '2026-11-30T00:00:00.000Z',
            });
        });
        const client = new PawsShareClient({ serverUrl: origin, token, retryDelayMs: 0 });

        const result = await client.createDraft('codex', requestId);

        expect(result.shareId).toBe('share-1');
        expect(attempts).toBe(2);
    });

    it('never includes the management token in API errors', async () => {
        const origin = await testServer((_request, response) => json(response, 400, { error: `rejected ${token}` }));
        const client = new PawsShareClient({ serverUrl: origin, token, retryDelayMs: 0 });

        let error: unknown;
        try {
            await client.createDraft('codex', requestId);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(PawsShareApiError);
        expect((error as Error).message).toBe('Paws Share request failed (400)');
        expect(JSON.stringify(error)).not.toContain(token);
    });
});
