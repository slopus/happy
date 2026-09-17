import tweetnacl from 'tweetnacl';
import type { PawsCredentials } from '../client/types';
import { PawsAgentError } from '../client/errors';
import { deriveContentKeyPair, encodeBase64, getRandomBytes } from '../crypto/encryption';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Restores an account from its 32-byte secret without creating a QR-link request. */
export async function restorePawsCredentialsWithSecret(options: {
    serverUrl: string;
    secret: Uint8Array;
    fetch?: FetchLike;
    clientName?: string;
    signal?: AbortSignal;
}): Promise<PawsCredentials> {
    if (options.secret.length !== 32) throw new PawsAgentError('AUTH_EXPIRED', 'Recovery code must decode to a 32-byte secret');
    const signing = tweetnacl.sign.keyPair.fromSeed(options.secret);
    const challenge = getRandomBytes(32);
    const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(`${options.serverUrl.replace(/\/+$/, '')}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Happy-Client': options.clientName ?? 'paws-agent-browser/0.1.0' },
        body: JSON.stringify({ publicKey: encodeBase64(signing.publicKey), challenge: encodeBase64(challenge), signature: encodeBase64(tweetnacl.sign.detached(challenge, signing.secretKey)) }),
        signal: options.signal,
    }).catch(cause => { throw new PawsAgentError('CONNECTION_LOST', 'Unable to reach the account restore service', { cause }); });
    if (!response.ok) throw new PawsAgentError(response.status === 401 ? 'AUTH_EXPIRED' : 'UNKNOWN', `Account restore failed (${response.status})`);
    const body = await response.json().catch(() => { throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Account restore response is not valid JSON'); }) as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Account restore response is incomplete');
    const secret = Uint8Array.from(options.secret);
    return { token: body.token, secret, contentKeyPair: deriveContentKeyPair(secret) };
}
