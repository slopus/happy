import { describe, expect, it, vi } from 'vitest';
import { relayProxyHttpRequest } from '@/app/api/routes/previewRoutes';

function socket(id: string, response: unknown) {
    const emitWithAck = vi.fn(async () => {
        if (response instanceof Error) throw response;
        return response;
    });
    return {
        id,
        timeout: vi.fn(() => ({ emitWithAck })),
        emitWithAck,
    };
}

const payload = {
    port: 3000,
    method: 'GET',
    path: '/',
    headers: {},
    bodyB64: null,
};

describe('relayProxyHttpRequest', () => {
    it('uses a healthy socket when another candidate times out', async () => {
        const stale = socket('stale', new Error('operation has timed out'));
        const fresh = socket('fresh', {
            type: 'success',
            status: 200,
            headers: {},
            bodyB64: '',
            truncated: false,
        });

        await expect(relayProxyHttpRequest([stale as never, fresh as never], payload, 10))
            .resolves
            .toMatchObject({ type: 'success', status: 200 });
        expect(stale.emitWithAck).toHaveBeenCalledTimes(1);
        expect(fresh.emitWithAck).toHaveBeenCalledTimes(1);
    });

    it('ignores malformed responses when another candidate returns a daemon error', async () => {
        const malformed = socket('old', { ok: true });
        const current = socket('current', {
            type: 'error',
            code: 'TIMEOUT',
            message: 'Upstream timed out',
        });

        await expect(relayProxyHttpRequest([malformed as never, current as never], payload, 10))
            .resolves
            .toMatchObject({ type: 'error', code: 'TIMEOUT' });
    });

    it('rejects when every candidate fails', async () => {
        const a = socket('a', new Error('operation has timed out'));
        const b = socket('b', { ok: true });

        await expect(relayProxyHttpRequest([a as never, b as never], payload, 10))
            .rejects
            .toThrow();
    });
});
