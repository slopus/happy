import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import {
    AntigravityModelCatalogRequestSchema,
    AntigravityModelCatalogSchema,
    type AntigravityModelCatalog,
} from '@slopus/happy-wire';
import { AcpBackend } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { resolveExecutable } from '@/environment/processRunner';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { Metadata } from '@/api/types';
import {
    extractConfigOptionsFromPayload,
    extractModelStateFromPayload,
    mergeAcpSessionConfigIntoMetadata,
    mergeAntigravityLegacyEfforts,
} from './sessionConfigMetadata';

/** Only initialize/session-new are used. No Happy session, prompt, MCP tools or configuration changes are published. */
export async function readAntigravityModelCatalog(options: {
    directory: string;
    command?: string;
    args?: string[];
    timeoutMs?: number;
}): Promise<AntigravityModelCatalog> {
    const command =
        options.command ?? (await resolveExecutable('agy', process.env.PATH, [join(homedir(), '.local/bin/agy')]));
    if (!command) throw new Error('Antigravity is not installed on this machine');
    const timeoutMs = options.timeoutMs ?? 15_000;
    const transport = new DefaultTransport('antigravity');
    transport.getInitTimeout = () => timeoutMs;
    const backend = new AcpBackend({
        agentName: 'antigravity',
        cwd: options.directory,
        command,
        args: options.args ?? ['acp'],
        startupAttempts: 1,
        transportHandler: transport,
        mcpServers: {},
        permissionHandler: { handleToolCall: async () => ({ decision: 'denied' }) },
    });
    let metadata: Metadata = {
        path: options.directory,
        host: '',
        flavor: 'antigravity',
        homeDir: '',
        happyHomeDir: '',
        happyLibDir: '',
        happyToolsDir: '',
    };
    let categorized = false;
    backend.onMessage((message) => {
        if (message.type !== 'event') return;
        if (message.name === 'config_options_update') {
            const configOptions = extractConfigOptionsFromPayload(message.payload);
            if (configOptions) {
                categorized = configOptions.some((option) => option.type === 'select' && option.category === 'model');
                metadata = mergeAcpSessionConfigIntoMetadata(metadata, { configOptions });
            }
        } else if (message.name === 'models_update') {
            const models = extractModelStateFromPayload(message.payload);
            if (models)
                metadata = categorized
                    ? mergeAntigravityLegacyEfforts(metadata, models)
                    : mergeAcpSessionConfigIntoMetadata(metadata, { models });
        }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            backend.startSession(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Antigravity model catalog timed out')), timeoutMs);
            }),
        ]);
        if (!metadata.models) throw new Error('Antigravity did not report a model catalog');
        return AntigravityModelCatalogSchema.parse({
            source: 'antigravity-native',
            observedAt: Date.now(),
            models: metadata.models,
            currentModelCode: metadata.currentModelCode,
            thoughtLevels: metadata.thoughtLevels,
            currentThoughtLevelCode: metadata.currentThoughtLevelCode,
        });
    } finally {
        if (timer) clearTimeout(timer);
        await backend.dispose();
    }
}

/** In-flight sharing only; a different directory cannot spawn another simultaneous catalog process. */
export function createAntigravityModelCatalogReader(read: (directory: string) => Promise<AntigravityModelCatalog>) {
    const inFlight = new Map<string, Promise<AntigravityModelCatalog>>();
    return (directory: string): Promise<AntigravityModelCatalog> => {
        const existing = inFlight.get(directory);
        if (existing) return existing;
        if (inFlight.size)
            return Promise.reject(new Error('Antigravity model discovery is busy; retry after the current read'));
        const pending = Promise.resolve()
            .then(() => read(directory))
            .finally(() => {
                inFlight.delete(directory);
            });
        inFlight.set(directory, pending);
        return pending;
    };
}
export function registerAntigravityModelCatalogHandler(
    registrar: Pick<RpcHandlerManager, 'registerHandler'>,
    read = createAntigravityModelCatalogReader((directory) => readAntigravityModelCatalog({ directory })),
) {
    registrar.registerHandler('antigravity-model-catalog', async (raw: unknown) => {
        const { directory } = AntigravityModelCatalogRequestSchema.parse(raw);
        if (!isAbsolute(directory)) throw new Error('Model catalog requires an absolute working directory');
        const target = await realpath(directory);
        if (!(await stat(target)).isDirectory()) throw new Error('Model catalog working directory is unavailable');
        return AntigravityModelCatalogSchema.parse(await read(target));
    });
}
