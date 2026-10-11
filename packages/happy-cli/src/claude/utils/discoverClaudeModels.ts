/** Discover the installed Claude catalog without submitting an inference turn. */
import { query, type ModelInfo, type Query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';

export async function discoverClaudeModels(options: {
    cwd: string;
    env?: Record<string, string>;
    signal: AbortSignal;
    useLocalCli: boolean;
}): Promise<ModelInfo[]> {
    if (options.signal.aborted) return [];
    const controller = new AbortController();
    let closeInput!: () => void;
    const inputClosed = new Promise<void>(resolve => { closeInput = resolve; });
    let rejectDiscovery!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectDiscovery = reject; });
    const abort = () => {
        controller.abort();
        rejectDiscovery(new Error('Claude model discovery cancelled'));
    };
    const timeout = setTimeout(abort, 10_000);
    options.signal.addEventListener('abort', abort, { once: true });
    let response: Query | undefined;
    try {
        let executable: string | undefined;
        if (options.useLocalCli) {
            // Reuse the same native/npm/PATH resolution as local mode. Passing
            // the .cjs trampoline itself makes the SDK execute it as a native
            // binary instead of through Node, which fails before initialization.
            const { findGlobalClaudeCliPath } = createRequire(import.meta.url)(
                resolve(projectPath(), 'scripts/claude_version_utils.cjs'),
            ) as { findGlobalClaudeCliPath: () => { path: string } | null };
            const override = options.env?.HAPPY_CLAUDE_PATH;
            executable = override && existsSync(override) ? resolve(override) : findGlobalClaudeCliPath()?.path;
            if (!executable) return [];
        }
        response = query({
            // An open, empty stream permits initialize/control requests, but
            // cannot produce a billable user turn. Always close it in finally.
            prompt: (async function* () { await inputClosed; })(),
            options: {
                cwd: options.cwd,
                env: { ...process.env, ...options.env },
                pathToClaudeCodeExecutable: executable,
                abortController: controller,
                settingSources: ['user', 'project', 'local'],
                settings: { disableAllHooks: true },
                tools: [],
                mcpServers: {},
                strictMcpConfig: true,
                persistSession: false,
            },
        });
        return await Promise.race([response.supportedModels(), cancelled]);
    } catch (error) {
        logger.debug('[claude] Model discovery unavailable; keeping existing metadata',
            error instanceof Error ? error.message : String(error));
        return [];
    } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', abort);
        closeInput();
        response?.close();
    }
}
