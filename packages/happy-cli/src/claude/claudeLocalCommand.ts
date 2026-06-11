import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { logger } from "@/ui/logger";
import { projectPath } from "@/projectPath";
import type { SandboxConfig } from "@/persistence";
import { initializeSandbox, wrapCommand } from "@/sandbox/manager";
import { ensureLocalProxyBypass } from "./utils/proxyBypass";
import { systemPrompt } from "./utils/systemPrompt";

export const claudeCliPath = resolve(join(projectPath(), 'scripts', 'claude_local_launcher.cjs'))

export type ClaudeLocalCommand = {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    cleanupSandbox: (() => Promise<void>) | null;
};

export type BuildClaudeLocalCommandOptions = {
    path: string;
    sessionArgs: string[];
    claudeEnvVars?: Record<string, string>;
    claudeArgs?: string[];
    mcpServers?: Record<string, any>;
    allowedTools?: string[];
    hookSettingsPath?: string;
    sandboxConfig?: SandboxConfig;
};

function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function buildClaudeLocalCommand(opts: BuildClaudeLocalCommandOptions): Promise<ClaudeLocalCommand> {
    const args: string[] = [...opts.sessionArgs];

    args.push('--append-system-prompt', systemPrompt);

    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowedTools', opts.allowedTools.join(','));
    }

    if (opts.claudeArgs) {
        args.push(...opts.claudeArgs);
    }

    if (opts.hookSettingsPath) {
        args.push('--settings', opts.hookSettingsPath);
    }

    if (!claudeCliPath || !existsSync(claudeCliPath)) {
        throw new Error('Claude local launcher not found. Please ensure HAPPY_PROJECT_ROOT is set correctly for development.');
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...opts.claudeEnvVars,
    };

    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env);
    }

    const baseCommand: ClaudeLocalCommand = {
        command: 'node',
        args: [claudeCliPath, ...args],
        cwd: opts.path,
        env,
        shell: false,
        cleanupSandbox: null,
    };

    if (!opts.sandboxConfig?.enabled) {
        return baseCommand;
    }

    if (process.platform === 'win32') {
        logger.warn('[ClaudeLocal] Sandbox is not supported on Windows; continuing without sandbox.');
        return baseCommand;
    }

    let cleanupSandbox: (() => Promise<void>) | null = null;

    try {
        cleanupSandbox = await initializeSandbox(opts.sandboxConfig, opts.path);
        const sandboxArgs = baseCommand.args.includes('--dangerously-skip-permissions')
            ? baseCommand.args
            : [...baseCommand.args, '--dangerously-skip-permissions'];
        const fullCommand = [
            'node',
            ...sandboxArgs.map((arg) => quoteShellArg(arg)),
        ].join(' ');

        const wrappedCommand = await wrapCommand(fullCommand);

        logger.info(
            `[ClaudeLocal] Sandbox enabled: workspace=${opts.sandboxConfig.workspaceRoot ?? opts.path}, network=${opts.sandboxConfig.networkMode}`,
        );

        return {
            ...baseCommand,
            command: wrappedCommand,
            args: [],
            shell: true,
            cleanupSandbox,
        };
    } catch (error) {
        logger.warn('[ClaudeLocal] Failed to initialize sandbox; continuing without sandbox.', error);
        if (cleanupSandbox) {
            try {
                await cleanupSandbox();
            } catch (cleanupError) {
                logger.warn('[ClaudeLocal] Failed to reset sandbox after failed sandbox launch.', cleanupError);
            }
        }
        return baseCommand;
    }
}
