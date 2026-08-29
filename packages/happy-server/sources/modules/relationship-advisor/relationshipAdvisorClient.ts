import type { PluginConnectionTestResult } from '@slopus/happy-wire';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, type Dispatcher } from 'undici';
import {
    streamRelationshipAdvisor,
    validateRelationshipAdvisorProviderUrl,
} from '@paws/plugins/relationship-advisor/server';

export {
    streamRelationshipAdvisor,
    type RelationshipAdvisorMessage,
    type StreamRelationshipAdvisorInput,
    type StreamRelationshipAdvisorOptions,
} from '@paws/plugins/relationship-advisor/server';

interface RelationshipAdvisorConnectionConfiguration {
    apiKey: string;
    baseUrl: string;
    model: string;
}

interface RelationshipAdvisorConnectionTestOptions {
    createDispatcher?: (addresses: readonly LookupAddress[]) => Dispatcher;
    fetchImpl?: typeof fetch;
    lookup?: (hostname: string) => Promise<LookupAddress[]>;
    timeoutMs?: number;
    validateBaseUrl?: (baseUrl: string) => Promise<string>;
}

export function createPinnedDispatcher(addresses: readonly LookupAddress[]): Dispatcher {
    return new Agent({
        connect: {
            lookup(_hostname, options, callback) {
                const requestedFamily = typeof options === 'number'
                    ? options
                    : Number(options.family ?? 0);
                const matchingAddresses = addresses.filter(({ family }) => (
                    !requestedFamily || family === requestedFamily
                ));
                if (matchingAddresses.length === 0) {
                    const error = new Error('Provider hostname resolved to no validated addresses') as NodeJS.ErrnoException;
                    error.code = 'ENOTFOUND';
                    (callback as (error: NodeJS.ErrnoException) => void)(error);
                    return;
                }
                if (typeof options === 'object' && options.all) {
                    (callback as (
                        error: NodeJS.ErrnoException | null,
                        addresses: LookupAddress[],
                    ) => void)(null, matchingAddresses);
                    return;
                }
                const selected = matchingAddresses[0]!;
                (callback as (
                    error: NodeJS.ErrnoException | null,
                    address: string,
                    family: number,
                ) => void)(null, selected.address, selected.family);
            },
        },
    });
}

function chatCompletionsUrl(baseUrl: string): string {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function failureCodeForStatus(status: number): Extract<PluginConnectionTestResult, { success: false }>['code'] {
    if (status === 401 || status === 403) return 'authentication_failed';
    if (status === 404) return 'model_not_found';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
}

/** Sends a minimal provider request so configuration can be checked without storing it. */
export async function testRelationshipAdvisorConnection(
    configuration: RelationshipAdvisorConnectionConfiguration,
    options: RelationshipAdvisorConnectionTestOptions = {},
): Promise<PluginConnectionTestResult> {
    let safeBaseUrl: string;
    let pinnedAddresses: LookupAddress[] = [];
    try {
        if (options.validateBaseUrl) {
            safeBaseUrl = await options.validateBaseUrl(configuration.baseUrl);
        } else {
            const lookup = options.lookup
                ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
            const validationLookup = (async (hostname: string) => {
                pinnedAddresses = await lookup(hostname);
                return pinnedAddresses;
            }) as unknown as typeof dnsLookup;
            safeBaseUrl = await validateRelationshipAdvisorProviderUrl(
                configuration.baseUrl,
                validationLookup,
            );
        }
    } catch {
        return { success: false, code: 'invalid_configuration' };
    }

    const dispatcher = pinnedAddresses.length > 0
        ? (options.createDispatcher ?? createPinnedDispatcher)(pinnedAddresses)
        : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    const startedAt = Date.now();
    try {
        const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
            method: 'POST',
            redirect: 'error',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${configuration.apiKey}`,
            },
            body: JSON.stringify({
                model: configuration.model,
                messages: [{ role: 'user', content: 'Reply with OK.' }],
                stream: false,
                max_tokens: 1,
                temperature: 0,
            }),
            // Node's fetch and the transitive DOM types expose structurally different
            // AbortSignal declarations, though they share the same runtime object.
            signal: controller.signal as never,
        };
        if (dispatcher) requestInit.dispatcher = dispatcher;
        const response = await (options.fetchImpl ?? fetch)(chatCompletionsUrl(safeBaseUrl), requestInit);
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { success: false, code: failureCodeForStatus(response.status) };
        }
        const body = await response.json().catch(() => null) as { choices?: unknown } | null;
        if (!body || !Array.isArray(body.choices) || body.choices.length === 0) {
            return { success: false, code: 'provider_error' };
        }
        return { success: true, latencyMs: Math.max(0, Date.now() - startedAt) };
    } catch (error) {
        if (controller.signal.aborted || (error as { name?: unknown })?.name === 'AbortError') {
            return { success: false, code: 'timed_out' };
        }
        return { success: false, code: 'provider_unreachable' };
    } finally {
        clearTimeout(timeout);
        await dispatcher?.close().catch(() => undefined);
    }
}
