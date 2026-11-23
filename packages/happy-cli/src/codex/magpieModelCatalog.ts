import { isAbsolute, basename } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { CodexMagpieCatalogSchema, type CodexMagpieCatalog } from '@slopus/happy-wire';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { CodexAppServerClient, resolveCodexAppServerConnection } from './codexAppServerClient';

/** Check the effective connection of the native Codex process, including project config. */
export function isMagpieModelConnection(config: Record<string, unknown>): boolean {
    const provider = String(config.model_provider ?? 'openai');
    const configured = (config.model_providers as Record<string, { base_url?: unknown }> | undefined)?.[provider];
    const baseUrl = configured?.base_url ?? (provider === 'openai' ? config.openai_base_url : undefined);
    const catalog = config.model_catalog_json;
    if (typeof baseUrl !== 'string' || typeof catalog !== 'string') return false;
    const url = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
    if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
    return provider === 'magpie' || (
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
        /^magpie(?:-[a-z0-9_-]+)?-models\.json$/i.test(basename(catalog))
    );
}

export const EXPECT_MAGPIE_CONNECTION_ENV = 'HAPPY_CODEX_EXPECT_MAGPIE_CONNECTION';

const requestSchema = z.object({ directory: z.string().min(1).max(4096) }).strict();

export function registerMagpieModelCatalogHandler(registrar: Pick<RpcHandlerManager, 'registerHandler'>) {
    const inFlight = new Map<string, Promise<CodexMagpieCatalog | null>>();
    registrar.registerHandler('list-codex-magpie-models', async (raw: unknown) => {
        const { directory } = requestSchema.parse(raw);
        if (!isAbsolute(directory)) throw new Error('Model catalog requires an absolute working directory');
        const target = await realpath(directory);
        if (!(await stat(target)).isDirectory()) throw new Error('Model catalog working directory is unavailable');
        const existing = inFlight.get(target);
        if (existing) return existing;
        const pending = readMagpieModelCatalog(target).finally(() => { inFlight.delete(target); });
        inFlight.set(target, pending);
        return pending;
    });
}

export async function readMagpieModelCatalog(directory: string): Promise<CodexMagpieCatalog | null> {
    // A managed OAuth home cannot supply the machine's native catalog.
    if (process.env.HAPPY_CODEX_ACCOUNT_PROFILE_ID || resolveCodexAppServerConnection().type !== 'spawn') return null;
    const client = new CodexAppServerClient(undefined, { type: 'spawn' }, process.env, undefined, directory);
    try {
        await client.connect();
        if (!isMagpieModelConnection(await client.readEffectiveModelConfiguration())) return null;
        const modelsUpdatedAt = Date.now();
        const models = new Map<string, CodexMagpieCatalog['models'][number]>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            const page = await client.listModels({ cursor, includeHidden: false, limit: 100 });
            for (const model of page.data) {
                if (model.hidden || models.has(model.model)) continue;
                models.set(model.model, {
                    code: model.model,
                    value: model.displayName || model.model,
                    description: model.description || null,
                    supportedEffortLevels: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort),
                    serviceTiers: model.serviceTiers ?? model.service_tiers ?? [],
                });
            }
            cursor = page.nextCursor ?? null;
            if (cursor && (cursors.has(cursor) || cursors.size >= 20)) throw new Error('Invalid model catalog pagination');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        return CodexMagpieCatalogSchema.parse({ models: [...models.values()], modelsUpdatedAt });
    } catch {
        throw new Error('Could not read the Magpie model directory');
    } finally {
        await client.disconnect();
    }
}
