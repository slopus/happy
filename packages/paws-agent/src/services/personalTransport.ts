import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { ServiceGrantSchema } from '@slopus/happy-wire/ai-services';
import { decodeBase64, decryptBoxBundle, encodeBase64, encodeBase64Url, getRandomBytes } from '../crypto/encryption';
import { canonical, checkedReceipt, createScopedServiceTransport, serviceRequest, serviceURL, type ScopedTransportOptions } from './scopedTransport';
import { waitForServicePoll } from './client';
import { AIServiceClientError, type AuthorizeOptions, type AIServiceTransport, type GrantReceipt } from './types';
interface PendingSecret {
    id: string;
    expiresAt: number;
    verifier: string;
    credential: string;
    secretKey: string;
}
export interface PersonalTransportOptions extends ScopedTransportOptions {
    webUrl: string;
}
/** Uses only the Paws origin. Personal credentials and message keys never visit an application backend. */
export function createBrowserPersonalTransport(options: PersonalTransportOptions): AIServiceTransport {
    const origin = options.origin ?? globalThis.location?.origin;
    if (!origin || new URL(origin).origin !== origin)
        throw new AIServiceClientError('invalid-request');
    if (globalThis.location && globalThis.location.origin !== origin)
        throw new AIServiceClientError('permission-denied');
    const server = serviceURL(options.serverUrl), web = serviceURL(options.webUrl), inner = createScopedServiceTransport({ ...options, origin }, 'personal-grant');
    let pendingAbort = new AbortController(), disposed = false;
    const pairingRequest = <T>(path: string, body: unknown, signal: AbortSignal) => serviceRequest<T>(options.fetch ?? fetch, server + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' }, signal);
    async function authorize(input: AuthorizeOptions = {}) {
        if (disposed)
            throw new AIServiceClientError('disposed');
        const existing = input.receipt ?? await options.storage.get<GrantReceipt>('connection');
        if (existing) {
            const receipt = checkedReceipt(existing, options.appId, 'personal-grant');
            const result = await inner.authorize({ ...input, receipt });
            await options.storage.set('connection', receipt);
            return result;
        }
        pendingAbort.abort();
        pendingAbort = new AbortController();
        const signal = input.signal ? AbortSignal.any([input.signal, pendingAbort.signal]) : pendingAbort.signal;
        let pending = await options.storage.get<PendingSecret>('pending-authorization');
        if (!pending || pending.expiresAt <= Date.now()) {
            const verifier = encodeBase64Url(getRandomBytes(32)), credential = encodeBase64Url(getRandomBytes(32)), pair = nacl.box.keyPair.fromSecretKey(getRandomBytes(32));
            const challengeHash = Array.from(sha256(new TextEncoder().encode(verifier)), b => b.toString(16).padStart(2, '0')).join('');
            const value = await pairingRequest<{
                id: string;
                expiresAt: number;
                protocol: string;
            }>('/v1/apps/ai-services/pairings', { appId: options.appId, publicKey: encodeBase64(pair.publicKey), challengeHash }, signal);
            if (value.protocol !== 'ai-services/1' || typeof value.id !== 'string' || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now())
                throw new AIServiceClientError('protocol-incompatible');
            pending = { id: value.id, expiresAt: value.expiresAt, verifier, credential, secretKey: encodeBase64(pair.secretKey) };
            await options.storage.set('pending-authorization', pending);
        }
        input.onPending?.({ id: pending.id, expiresAt: pending.expiresAt, approvalUrl: `${web}/apps/authorize?id=${encodeURIComponent(pending.id)}&protocol=ai-services%2F1`, qrUrl: `paws:///apps/authorize?id=${encodeURIComponent(pending.id)}&protocol=ai-services%2F1` });
        try {
            while (Date.now() < pending.expiresAt) {
                const result = await pairingRequest<{
                    state: string;
                    id?: string;
                    protocol?: string;
                    envelope?: string;
                    grant?: unknown;
                }>(`/v1/apps/ai-services/pairings/${encodeURIComponent(pending.id)}/redeem`, { verifier: pending.verifier, credential: pending.credential }, signal);
                if (result.state === 'authorized') {
                    const parsed = ServiceGrantSchema.safeParse(result.grant);
                    if (!parsed.success || result.protocol !== 'ai-services/1' || result.id !== pending.id || parsed.data.id !== pending.id || parsed.data.kind !== 'personal-grant' || !result.envelope)
                        throw new AIServiceClientError('context-mismatch');
                    let envelope: Record<string, unknown>;
                    try {
                        const plain = decryptBoxBundle(decodeBase64(result.envelope), decodeBase64(pending.secretKey));
                        if (!plain)
                            throw 0;
                        envelope = JSON.parse(new TextDecoder().decode(plain));
                    }
                    catch {
                        throw new AIServiceClientError('context-mismatch');
                    }
                    const grant = parsed.data;
                    if (envelope.protocol !== 'ai-services/1' || envelope.grantId !== grant.id || envelope.ownerId !== grant.ownerId || envelope.appId !== options.appId || envelope.serviceId !== grant.scope.serviceId || canonical(envelope.scope) !== canonical(grant.scope))
                        throw new AIServiceClientError('context-mismatch');
                    const receipt = checkedReceipt({ ...grant, credential: `paws_service.${grant.id}.${pending.credential}`, messageKey: envelope.messageKey }, options.appId, 'personal-grant');
                    // Save the receipt before another HTTP call. A lost redeem response retains its original proof/secret.
                    if (signal.aborted)
                        throw new AIServiceClientError('aborted');
                    await options.storage.set('connection', receipt);
                    await options.storage.remove('pending-authorization');
                    return inner.authorize({ ...input, receipt });
                }
                if (result.state !== 'pending')
                    throw new AIServiceClientError('protocol-incompatible');
                await waitForServicePoll(Math.min(1500, pending.expiresAt - Date.now()), signal);
            }
            await options.storage.remove('pending-authorization');
            throw new AIServiceClientError('authorization-expired');
        }
        catch (error) {
            if (signal.aborted) {
                await options.storage.remove('pending-authorization');
                throw new AIServiceClientError('aborted');
            }
            throw error;
        }
    }
    return { ...inner, authorize, disconnect() { pendingAbort.abort(); inner.disconnect(); void options.storage.remove('pending-authorization').catch(() => undefined); }, dispose() { if (disposed)
            return; disposed = true; pendingAbort.abort(); inner.dispose(); } };
}
