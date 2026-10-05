import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from '../crypto/encryption';
import { expect } from 'vitest';
import type { ExecutionBinding, GrantReceipt, TurnRecord } from '@slopus/happy-wire/ai-services';
export const binding: ExecutionBinding = { id: 'binding', appId: 'advisor', serviceId: 'service', revision: 1, machineId: 'machine', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'profile' }, requestedModel: null, reasoning: { mode: 'default' }, permissions: ['chat'] };
export const makeReceipt = (kind: GrantReceipt['kind']): GrantReceipt => ({ id: 'grant', ownerId: 'owner', kind, protocol: 'ai-services/1', scope: { appId: 'advisor', serviceId: 'service', targets: [{ machineId: 'machine', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'profile' } }], permissions: ['chat'], expiresAt: null }, createdAt: 1, revokedAt: null, credential: 'paws_service.grant.' + 'A'.repeat(43), messageKey: encodeBase64(new Uint8Array(32).fill(7)) });
export function encrypt(value: unknown) { const nonce = new Uint8Array(24).fill(9); return encodeBase64(new Uint8Array([...nonce, ...nacl.secretbox(new TextEncoder().encode(JSON.stringify(value)), nonce, new Uint8Array(32).fill(7))])); }
export function fixture() {
    let row: {
        record: TurnRecord;
        input: string;
        output: string | null;
        sequence: number;
    } | null = null;
    let lose = true, posts = 0, ciphertext = '', bad = false;
    const requests: {
        path: string;
        headers: Headers;
        body: unknown;
    }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
        const path = new URL(String(url)).pathname, headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, headers, body });
        if (path === '/v1/apps/services')
            return Response.json({ services: [{ id: 'service', ownerId: 'owner', name: 'My AI', enabled: true, revision: 1 }], app: { appId: 'advisor', name: 'Advisor', origins: ['https://app.test'], capabilities: ['chat'], businessPrompt: { id: 'prompt', version: '1' } } });
        if (path === '/v1/apps/ai-services/bindings')
            return Response.json({ binding });
        if (path.endsWith('/requests/request'))
            return row ? Response.json(row) : Response.json({ error: { code: 'invalid-request', retryable: false } }, { status: 400 });
        if (path.endsWith('/turns') && init?.method === 'POST') {
            posts++;
            ciphertext = body.ciphertext;
            const bytes = decodeBase64(ciphertext);
            const plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), new Uint8Array(32).fill(7));
            expect(JSON.parse(new TextDecoder().decode(plain!))).toEqual({ protocol: 'ai-services/1', grantId: 'grant', appId: 'advisor', serviceId: 'service', bindingId: 'binding', requestId: 'request', direction: 'input', sequence: 0, messages: [{ role: 'user', text: 'hello' }] });
            row = { record: { id: 'turn', conversationId: 'binding', requestId: 'request', binding, status: 'accepted', actual: { modelId: null, reasoning: null }, createdAt: 2, startedAt: null, completedAt: null, error: null }, input: ciphertext, output: null, sequence: 0 };
            if (lose) {
                lose = false;
                throw new TypeError('secret upstream trace');
            }
            return Response.json({ record: row.record });
        }
        if (path.endsWith('/turns/turn')) {
            row!.record = { ...row!.record, status: 'completed', completedAt: 3 };
            row!.sequence = 1;
            row!.output = encrypt({ protocol: 'ai-services/1', grantId: 'grant', appId: 'advisor', serviceId: 'service', bindingId: bad ? 'foreign' : 'binding', requestId: 'request', turnId: 'turn', direction: 'output', sequence: 1, text: 'answer' });
            return Response.json(row);
        }
        throw new Error('Unexpected route ' + path);
    };
    return { fetcher, requests, get posts() { return posts; }, get ciphertext() { return ciphertext; }, corrupt() { bad = true; } };
}
