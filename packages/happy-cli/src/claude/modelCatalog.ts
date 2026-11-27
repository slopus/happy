import { query, type Query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeModelCatalogSchema, type ClaudeModelCatalog } from '@slopus/happy-wire';
import { z } from 'zod';
import { installedClaudeExecutable } from './installedClaude';
import { buildClaudeProcessEnv } from './sdk/claudeProcessEnv';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { ClaudeModelCatalogRequestSchema } from '@slopus/happy-wire';
import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { readClaudeModelConnection } from './modelCatalogContext';
import type { Metadata } from '@/api/types';

const NativeModelsSchema = z.array(z.object({
    value: z.string().min(1).max(512), displayName: z.string().min(1).max(900),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(z.string().min(1).max(64)).max(32).optional(),
})).min(1).max(1024);

export function normalizeClaudeModels(input: unknown): ClaudeModelCatalog['models'] {
    const models = NativeModelsSchema.parse(input);
    const ids = new Set<string>();
    return models.map(model => {
        if (ids.has(model.value)) throw new Error('Duplicate Claude model identifier');
        ids.add(model.value);
        const duplicateName = models.some(other => other.value !== model.value && other.displayName === model.displayName);
        return {
            code: model.value,
            value: duplicateName ? `${model.displayName} · ${model.value}` : model.displayName,
            ...(model.supportsEffort === false ? { supportedEffortLevels: [] }
                : model.supportedEffortLevels ? { supportedEffortLevels: [...new Set(model.supportedEffortLevels)] } : {}),
        };
    });
}

type Probe = (params: { prompt: AsyncIterable<any>; options: Options }) => Pick<Query, 'initializationResult' | 'close'>;
export type NativeClaudeModelCatalog = ClaudeModelCatalog & { connectionKey?: string };

export function markClaudeModelConnection(metadata: Metadata, initialized: boolean | undefined, connectionKey: string | undefined): Metadata {
    return { ...metadata,
        ...(initialized ? { claudeModelConnectionKey: connectionKey } : {}),
        ...(initialized && !connectionKey ? { models: undefined, modelsUpdatedAt: undefined, currentModelCode: undefined, thoughtLevels: undefined, currentThoughtLevelCode: undefined } : {}),
        capabilities: { ...metadata.capabilities, claudeModelCatalogRefresh: !!connectionKey } };
}

export function isClaudeEffortSupported(effort: string, model: string | undefined, models?: ClaudeModelCatalog['models']): boolean {
    const levels = models?.find(entry => entry.code === (model ?? 'default'))?.supportedEffortLevels;
    return levels ? levels.includes(effort) : ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
}

/** Only the initialize control handshake is used: the input stream never receives a user message. */
export async function readClaudeModelCatalog(
    options: { directory: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
    probe: Probe = query,
): Promise<NativeClaudeModelCatalog> {
    const controller = new AbortController();
    const observedAt = Date.now();
    const messages = new PushableAsyncIterable<any>();
    let child: ReturnType<Probe> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Claude model catalog timed out')); }, options.timeoutMs ?? 15_000);
    });
    try {
        const executable = installedClaudeExecutable();
        const env = buildClaudeProcessEnv(options.env);
        controller.signal.throwIfAborted();
        child = probe({ prompt: messages, options: {
            cwd: options.directory, env,
            pathToClaudeCodeExecutable: executable,
            abortController: controller, persistSession: false,
            tools: [], mcpServers: {}, strictMcpConfig: true,
            settings: { disableAllHooks: true }, stderr: () => {},
        } });
        const initialization = await Promise.race([
            child.initializationResult(),
            deadline,
        ]);
        const connectionKey = await Promise.race([readClaudeModelConnection(child, env, executable, initialization.account), deadline]);
        return { ...ClaudeModelCatalogSchema.parse({ source: 'claude-native', observedAt, models: normalizeClaudeModels(initialization.models) }),
            connectionKey };
    } finally {
        if (timer) clearTimeout(timer);
        messages.end();
        child?.close();
    }
}

export function registerClaudeModelCatalogHandler(registrar: Pick<RpcHandlerManager, 'registerHandler'>) {
    const read = createClaudeModelCatalogReader(directory => readClaudeModelCatalog({ directory }));
    registrar.registerHandler('claude-model-catalog', async (raw: unknown) => {
        const { directory } = ClaudeModelCatalogRequestSchema.parse(raw);
        if (!isAbsolute(directory)) throw new Error('Model catalog requires an absolute working directory');
        const target = await realpath(directory);
        if (!(await stat(target)).isDirectory()) throw new Error('Model catalog working directory is unavailable');
        return ClaudeModelCatalogSchema.parse(await read(target));
    });
}

/** In-flight deduplication only. Each subsequent user action reads the current configuration. */
export function createClaudeModelCatalogReader(read: (directory: string) => Promise<NativeClaudeModelCatalog>) {
    const inFlight = new Map<string, Promise<NativeClaudeModelCatalog>>();
    return (directory: string): Promise<NativeClaudeModelCatalog> => {
        const existing = inFlight.get(directory);
        if (existing) return existing;
        const pending = read(directory).finally(() => { inFlight.delete(directory); });
        inFlight.set(directory, pending);
        return pending;
    };
}
