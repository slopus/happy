import { it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { createBrowserPersonalTransport } from './personalTransport';
import { createMemoryServiceStorage } from './storage';
import { encodeBase64, decodeBase64, getRandomBytes } from '../crypto/encryption';
import { makeReceipt, fixture } from './testFixtures';
import type { GrantReceipt } from './types';
it('assembles the personal receipt only after checking the recipient-sealed identity and scope', async () => {
    const storage = createMemoryServiceStorage(), scoped = fixture();
    let publicKey!: Uint8Array, secret = '', lost = true;
    const grant = makeReceipt('personal-grant');
    const { credential, messageKey, ...metadata } = grant;
    const fetcher: typeof fetch = async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (String(url).endsWith('/pairings')) {
            publicKey = decodeBase64(body.publicKey);
            return Response.json({ id: 'grant', protocol: 'ai-services/1', expiresAt: Date.now() + 60000 });
        }
        if (String(url).endsWith('/redeem')) {
            if (secret)
                expect(body.credential).toBe(secret);
            secret = body.credential;
            const ephemeral = nacl.box.keyPair(), nonce = getRandomBytes(24), plain = { protocol: 'ai-services/1', grantId: 'grant', ownerId: 'owner', appId: 'advisor', serviceId: 'service', scope: grant.scope, messageKey };
            const envelope = encodeBase64(new Uint8Array([...ephemeral.publicKey, ...nonce, ...nacl.box(new TextEncoder().encode(JSON.stringify(plain)), nonce, publicKey, ephemeral.secretKey)]));
            if (lost) {
                lost = false;
                throw new TypeError('lost redemption response');
            }
            return Response.json({ state: 'authorized', id: 'grant', protocol: 'ai-services/1', grant: metadata, envelope });
        }
        return scoped.fetcher(url, init);
    };
    const make = () => createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: fetcher });
    const first = make();
    await expect(first.authorize()).rejects.toMatchObject({ code: 'transport-error' });
    const pending = await storage.get<any>('pending-authorization');
    expect(pending.credential).toBe(secret);
    first.dispose();
    const second = make();
    const result = await second.authorize();
    expect(result).toEqual({ id: 'grant', source: 'personal', appId: 'advisor', serviceId: 'service', expiresAt: null });
    const receipt = await storage.get<GrantReceipt>('connection');
    expect(receipt?.createdAt).toBe(1);
    expect(receipt?.credential).toBe('paws_service.grant.' + secret);
    expect(await storage.get('pending-authorization')).toBeNull();
    second.dispose();
});
it('does not store a mismatched sealed app receipt', async () => {
    const storage = createMemoryServiceStorage();
    let publicKey!: Uint8Array;
    const grant = makeReceipt('personal-grant'), { credential, messageKey, ...metadata } = grant;
    const fetcher: typeof fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith('/pairings')) {
            publicKey = decodeBase64(body.publicKey);
            return Response.json({ id: 'grant', protocol: 'ai-services/1', expiresAt: Date.now() + 60000 });
        }
        const ephemeral = nacl.box.keyPair(), nonce = getRandomBytes(24), plain = { protocol: 'ai-services/1', grantId: 'grant', ownerId: 'owner', appId: 'foreign-app', serviceId: 'service', scope: grant.scope, messageKey };
        return Response.json({ state: 'authorized', id: 'grant', protocol: 'ai-services/1', grant: metadata, envelope: encodeBase64(new Uint8Array([...ephemeral.publicKey, ...nonce, ...nacl.box(new TextEncoder().encode(JSON.stringify(plain)), nonce, publicKey, ephemeral.secretKey)])) });
    };
    const t = createBrowserPersonalTransport({ appId: 'advisor', serverUrl: 'https://paws.test', webUrl: 'https://web.test', origin: 'https://app.test', storage, fetch: fetcher });
    await expect(t.authorize()).rejects.toMatchObject({ code: 'context-mismatch' });
    expect(await storage.get('connection')).toBeNull();
    t.dispose();
});
