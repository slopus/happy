import tweetnacl from 'tweetnacl';
import type { CredentialProvider, PawsCredentials } from '../client/types';
import { PawsAgentError } from '../client/errors';
import {
    decodeBase64,
    decryptBoxBundle,
    deriveContentKeyPair,
    encodeBase64,
    encodeBase64Url,
    getRandomBytes,
} from '../crypto/encryption';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type AccountLinkResponse = {
    state?: unknown;
    token?: unknown;
    response?: unknown;
};

export type BrowserAccountLinkOptions = {
    serverUrl: string;
    credentials: CredentialProvider;
    fetch?: FetchLike;
    clientName?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
};

export type WaitForBrowserAccountLinkOptions = {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
};

export type BrowserAccountLinkSession = {
    publicKey: string;
    qrUrl: string;
    waitForAuthorization(options?: WaitForBrowserAccountLinkOptions): Promise<PawsCredentials>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export async function startBrowserAccountLink(
    options: BrowserAccountLinkOptions,
): Promise<BrowserAccountLinkSession> {
    const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    const serverUrl = options.serverUrl.replace(/\/+$/, '');
    const keyPair = tweetnacl.box.keyPair.fromSecretKey(getRandomBytes(32));
    const publicKey = encodeBase64(keyPair.publicKey);
    const clientName = options.clientName ?? 'paws-agent-browser/0.1.0';

    const initialRequestSignal = createDeadlineSignal(
        options.signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
        await requestAccountLink(fetcher, serverUrl, publicKey, clientName, initialRequestSignal.signal);
    } finally {
        initialRequestSignal.dispose();
    }

    return {
        publicKey,
        qrUrl: `paws:///account?${encodeBase64Url(keyPair.publicKey)}`,
        async waitForAuthorization(waitOptions = {}) {
            const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const pollIntervalMs = waitOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
            const deadline = Date.now() + timeoutMs;
            const requestSignal = createDeadlineSignal(waitOptions.signal, timeoutMs);

            try {
                while (Date.now() < deadline) {
                    throwIfAborted(requestSignal.signal);
                    await delay(pollIntervalMs, requestSignal.signal);
                    const result = await requestAccountLink(fetcher, serverUrl, publicKey, clientName, requestSignal.signal);
                    if (result.state !== 'authorized') continue;
                    if (typeof result.token !== 'string' || typeof result.response !== 'string') {
                        throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Account link response is incomplete');
                    }

                    const secret = decryptBoxBundle(decodeBase64(result.response), keyPair.secretKey);
                    if (!secret) {
                        throw new PawsAgentError('DECRYPTION_FAILED', 'Account link response could not be decrypted');
                    }

                    const credentials: PawsCredentials = {
                        token: result.token,
                        secret,
                        contentKeyPair: deriveContentKeyPair(secret),
                    };
                    await options.credentials.setCredentials(credentials);
                    return credentials;
                }

                throw new PawsAgentError('RPC_TIMEOUT', 'Account linking timed out');
            } finally {
                requestSignal.dispose();
            }
        },
    };
}

async function requestAccountLink(
    fetcher: FetchLike,
    serverUrl: string,
    publicKey: string,
    clientName: string,
    signal?: AbortSignal,
): Promise<AccountLinkResponse> {
    let response: Response;
    try {
        response = await fetcher(`${serverUrl}/v1/auth/account/request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Happy-Client': clientName,
            },
            body: JSON.stringify({ publicKey }),
            signal,
        });
    } catch (cause) {
        if (signal?.aborted) throw abortReason(signal);
        throw new PawsAgentError('CONNECTION_LOST', 'Unable to reach the account link service', { cause });
    }
    if (!response.ok) {
        throw new PawsAgentError(
            response.status === 401 ? 'AUTH_EXPIRED' : 'UNKNOWN',
            `Account link request failed (${response.status})`,
        );
    }

    try {
        return await response.json() as AccountLinkResponse;
    } catch (cause) {
        throw new PawsAgentError('PROTOCOL_UNSUPPORTED', 'Account link response is not valid JSON', { cause });
    }
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw abortReason(signal);
    }
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');
}

function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal;
    dispose(): void;
} {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parent ? abortReason(parent) : undefined);
    if (parent?.aborted) onAbort();
    else parent?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
        controller.abort(new PawsAgentError('RPC_TIMEOUT', 'Account linking timed out'));
    }, Math.max(0, timeoutMs));
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            parent?.removeEventListener('abort', onAbort);
        },
    };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        throwIfAborted(signal);
        return Promise.resolve();
    }
    const abortSignal = signal;
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            abortSignal?.removeEventListener('abort', onAbort);
            reject(abortSignal ? abortReason(abortSignal) : new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            abortSignal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
}
