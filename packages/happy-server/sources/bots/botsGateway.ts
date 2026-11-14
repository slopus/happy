import { BotsLaunchResponseSchema, type BotsLaunchRequest, type BotsLaunchResponse } from '@slopus/happy-wire';

export class BotsUnavailableError extends Error {}
export class BotsOriginError extends Error {}

export interface BotsGatewayOptions {
    env?: NodeJS.ProcessEnv;
    fetcher?: typeof fetch;
}

export async function launchBots(subject: string, input: BotsLaunchRequest, signal?: AbortSignal, options: BotsGatewayOptions = {}): Promise<BotsLaunchResponse> {
    const env = options.env ?? process.env;
    const endpoint = env.PAWS_BOTS_GATEWAY_BOOTSTRAP_URL;
    const secret = env.PAWS_BOTS_BRIDGE_SECRET;
    if (!endpoint || !secret || secret.length < 32) throw new BotsUnavailableError('Bots runtime is not configured');
    const parentOrigin = new URL(input.parentOrigin).origin;
    const allowed = (env.PAWS_BOTS_ALLOWED_PARENT_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowed.includes(parentOrigin)) throw new BotsOriginError('This Paws origin is not enabled for Bots');
    let url: URL;
    try {
        url = new URL(endpoint);
        // The bootstrap is a private, credential-bearing server-to-server channel.
        // Public runtimes are reached by the client, never by forwarding a Paws token.
        if (url.username || url.password || url.search || url.hash || url.pathname !== '/__paws/bootstrap'
            || !['http:', 'https:'].includes(url.protocol)
            || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
    } catch { throw new BotsUnavailableError('Bots private gateway endpoint is invalid'); }
    try {
        const init = {
            method: 'POST',
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
            headers: { 'content-type': 'application/json', 'x-paws-bridge-secret': secret },
            body: JSON.stringify({ ...input, subject, parentOrigin }),
        } as Parameters<typeof fetch>[1];
        const response = await (options.fetcher ?? fetch)(url.toString(), init);
        if (!response.ok) throw new Error('Private gateway rejected launch');
        const parsed = BotsLaunchResponseSchema.parse(await response.json());
        if (new URL(parsed.runtimeUrl).origin === parentOrigin) throw new Error('Bots runtime requires a separate origin');
        if (parsed.expiresAt <= Date.now() || parsed.expiresAt > Date.now() + 90_000) throw new Error('Invalid gateway ticket lifetime');
        return parsed;
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new BotsUnavailableError('Bots runtime is unavailable');
    }
}
