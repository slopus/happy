import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    mockReadCredentials: vi.fn(),
    mockApiCreate: vi.fn(),
    mockAuthenticateCodex: vi.fn(),
    mockAuthenticateClaude: vi.fn(),
    mockAuthenticateGemini: vi.fn(),
    mockDecodeJwtPayload: vi.fn(),
}));

vi.mock('@/persistence', () => ({
    readCredentials: mocks.mockReadCredentials,
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: mocks.mockApiCreate,
    },
}));

vi.mock('./connect/authenticateCodex', () => ({
    authenticateCodex: mocks.mockAuthenticateCodex,
}));

vi.mock('./connect/authenticateClaude', () => ({
    authenticateClaude: mocks.mockAuthenticateClaude,
}));

vi.mock('./connect/authenticateGemini', () => ({
    authenticateGemini: mocks.mockAuthenticateGemini,
}));

vi.mock('./connect/utils', () => ({
    decodeJwtPayload: mocks.mockDecodeJwtPayload,
}));

vi.mock('chalk', () => ({
    default: new Proxy({}, {
        get: () => (value: string) => value
    })
}));

import { handleConnectCommand } from './connect';

describe('handleConnectCommand', () => {
    const registerVendorToken = vi.fn();
    const getVendorToken = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();

        mocks.mockReadCredentials.mockResolvedValue({
            token: 'happy-token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        });
        mocks.mockApiCreate.mockResolvedValue({
            registerVendorToken,
            getVendorToken,
        });
        mocks.mockAuthenticateCodex.mockResolvedValue({ access_token: 'openai-token' });
        mocks.mockAuthenticateClaude.mockResolvedValue({ access_token: 'anthropic-token' });
        mocks.mockAuthenticateGemini.mockResolvedValue({ access_token: 'gemini-token' });
        mocks.mockDecodeJwtPayload.mockReturnValue(null);

        vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('process.exit');
        }) as never);
    });

    it('passes an onProgress callback to registerVendorToken for codex connect', async () => {
        registerVendorToken.mockResolvedValue(undefined);

        await expect(handleConnectCommand(['codex'])).rejects.toThrow('process.exit');

        expect(registerVendorToken).toHaveBeenCalledTimes(1);
        const [vendor, payload, options] = registerVendorToken.mock.calls[0];
        expect(vendor).toBe('openai');
        expect(payload).toEqual({ oauth: { access_token: 'openai-token' } });
        expect(options).toEqual(expect.objectContaining({
            onProgress: expect.any(Function),
        }));
    });

    it('prints unique progress stages while waiting for registration', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        registerVendorToken.mockImplementation(async (_vendor: string, _payload: unknown, options?: { onProgress?: (status: { stage: string }) => void }) => {
            options?.onProgress?.({ stage: 'accepted' });
            options?.onProgress?.({ stage: 'persisting' });
            options?.onProgress?.({ stage: 'persisting' });
            options?.onProgress?.({ stage: 'succeeded' });
        });

        await expect(handleConnectCommand(['codex'])).rejects.toThrow('process.exit');

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Request accepted by Happy cloud'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Persisting encrypted token'));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registration complete'));
        expect(logSpy.mock.calls.filter(([message]) => String(message).includes('Persisting encrypted token'))).toHaveLength(1);
    });
});
