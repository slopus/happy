import { describe, expect, it, vi } from 'vitest';
import { BotsOriginError, BotsUnavailableError, launchBots } from './botsGateway';

const env = {
    PAWS_BOTS_GATEWAY_BOOTSTRAP_URL: 'http://127.0.0.1:3490/__paws/bootstrap',
    PAWS_BOTS_BRIDGE_SECRET: 'a'.repeat(64),
    PAWS_BOTS_ALLOWED_PARENT_ORIGINS: 'https://paws.test',
};
const input = { parentOrigin: 'https://paws.test', platform: 'web' as const };
const ticket = () => ({ runtimeUrl: 'https://bots.test/', ticket: 't'.repeat(43), expiresAt: Date.now() + 60_000 });

describe('Paws Bots gateway bridge', () => {
    it('fails unavailable without configuration, without touching an upstream', async () => {
        const fetcher = vi.fn();
        await expect(launchBots('alice', input, undefined, { env: {}, fetcher })).rejects.toBeInstanceOf(BotsUnavailableError);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('refuses a non-private bootstrap URL and unapproved parent origin', async () => {
        const fetcher = vi.fn();
        await expect(launchBots('alice', input, undefined, { env: { ...env, PAWS_BOTS_GATEWAY_BOOTSTRAP_URL: 'https://attacker.test/__paws/bootstrap' }, fetcher })).rejects.toBeInstanceOf(BotsUnavailableError);
        await expect(launchBots('alice', { ...input, parentOrigin: 'https://attacker.test' }, undefined, { env, fetcher })).rejects.toBeInstanceOf(BotsOriginError);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('forwards only the authenticated subject and bridge secret, never a Paws token', async () => {
        const response = ticket();
        const fetcher = vi.fn(async (_url, init) => {
            expect(init?.headers).toEqual({ 'content-type': 'application/json', 'x-paws-bridge-secret': env.PAWS_BOTS_BRIDGE_SECRET });
            expect(JSON.parse(init?.body as string)).toEqual({ ...input, subject: 'authenticated-alice' });
            expect(init?.redirect).toBe('error');
            return Response.json(response);
        }) as unknown as typeof fetch;
        expect(await launchBots('authenticated-alice', input, undefined, { env, fetcher })).toEqual(response);
    });
    it('rejects runtime URL credentials, path, query, public HTTP, or expired tickets', async () => {
        for (const runtimeUrl of ['https://user:password@bots.test/', 'https://bots.test/embedded', 'https://bots.test/?ticket=x', 'http://bots.test/', 'https://paws.test/']) {
            const fetcher = vi.fn(async () => Response.json({ ...ticket(), runtimeUrl })) as unknown as typeof fetch;
            await expect(launchBots('alice', input, undefined, { env, fetcher })).rejects.toBeInstanceOf(BotsUnavailableError);
        }
        const fetcher = vi.fn(async () => Response.json({ ...ticket(), expiresAt: Date.now() - 1 })) as unknown as typeof fetch;
        await expect(launchBots('alice', input, undefined, { env, fetcher })).rejects.toBeInstanceOf(BotsUnavailableError);
    });
    it('propagates cancellation to the pending private request', async () => {
        const controller = new AbortController();
        const fetcher = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })) as unknown as typeof fetch;
        const pending = launchBots('alice', input, controller.signal, { env, fetcher });
        controller.abort(new Error('client left'));
        await expect(pending).rejects.toThrow('client left');
    });
});
