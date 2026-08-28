#!/usr/bin/env node

import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { join } from 'node:path';
import packageMetadata from '../package.json' with { type: 'json' };
import { PawsAgentClient } from './client/PawsAgentClient';
import { PawsAgentError } from './client/errors';
import type { Machine, PawsAgentClientOptions, Session, SupportedAgent } from './client/types';
import { FileCredentialProvider } from './adapters/nodeCredentials';
import { authLogin, authLogout, authStatus } from './auth';
import { loadConfig } from './config';
import {
    formatJson,
    formatMachineTable,
    formatMessageHistory,
    formatSessionStatus,
    formatSessionTable,
} from './cli/output';

const SUPPORTED_AGENTS: SupportedAgent[] = ['ask', 'claude', 'codex', 'gemini', 'opencode', 'openclaw'];

export type CliDependencies = {
    client: PawsAgentClient;
    auth: {
        login(): Promise<void>;
        logout(): Promise<void>;
        status(): Promise<void>;
    };
    stdout(value: string): void;
    stderr(value: string): void;
};

function defaultDependencies(): CliDependencies {
    const config = loadConfig();
    const credentials = new FileCredentialProvider(config.credentialPath);
    const options: PawsAgentClientOptions = { serverUrl: config.serverUrl, credentials };
    return {
        client: new PawsAgentClient(options),
        auth: {
            login: () => authLogin(config),
            logout: () => authLogout(config),
            status: () => authStatus(config),
        },
        stdout: value => process.stdout.write(value),
        stderr: value => process.stderr.write(value),
    };
}

function resolveByPrefix<T extends { id: string }>(items: T[], value: string, label: string): T {
    if (!value.trim()) throw new Error(`${label} is required`);
    const matches = items.filter(item => item.id.startsWith(value));
    if (matches.length === 0) throw new Error(`No ${label.toLowerCase()} found matching "${value}"`);
    if (matches.length > 1) throw new Error(`Ambiguous ${label.toLowerCase()} "${value}" matches ${matches.length} records. Be more specific.`);
    return matches[0];
}

async function resolveSession(client: PawsAgentClient, value: string): Promise<Session> {
    return resolveByPrefix(await client.sessions.list(), value, 'Session ID');
}

async function resolveMachine(client: PawsAgentClient, value: string): Promise<Machine> {
    return resolveByPrefix(await client.machines.list(), value, 'Machine ID');
}

function resolveRemotePath(rawPath: string | undefined, machine: Machine): string {
    const metadata = (machine.metadata ?? {}) as { homeDir?: unknown };
    const homeDir = typeof metadata.homeDir === 'string' && metadata.homeDir.trim() ? metadata.homeDir : undefined;
    const path = rawPath ?? homeDir;
    if (!path) throw new Error('Machine metadata does not include a home directory. Pass --path explicitly.');
    if (path === '~') {
        if (!homeDir) throw new Error('Machine metadata does not include a home directory, so `~` cannot be resolved.');
        return homeDir;
    }
    if (path.startsWith('~/')) {
        if (!homeDir) throw new Error('Machine metadata does not include a home directory, so `~/...` cannot be resolved.');
        const normalizedHome = homeDir.replace(/[\\/]$/, '');
        const separator = normalizedHome.includes('\\') && !normalizedHome.includes('/') ? '\\' : '/';
        return join(normalizedHome, path.slice(2)).replaceAll('/', separator);
    }
    return path;
}

export function isIdle(session: Session): boolean {
    const metadata = session.metadata as { lifecycleState?: unknown } | null;
    if (metadata?.lifecycleState === 'archived') throw new Error('Session is archived');
    const state = session.agentState as {
        controlledByUser?: unknown;
        requests?: unknown;
        turnStatus?: { status?: unknown };
    } | null;
    if (!state) return false;
    if (state.turnStatus?.status === 'running') return false;
    const requests = state.requests;
    const hasRequests = requests != null && typeof requests === 'object' && !Array.isArray(requests)
        && Object.keys(requests as Record<string, unknown>).length > 0;
    return state.controlledByUser !== true && !hasRequests;
}

async function waitForIdle(client: PawsAgentClient, sessionId: string, timeoutMs: number, requireActivity = false): Promise<void> {
    const startedAt = Date.now();
    let sawActivity = !requireActivity;
    while (Date.now() - startedAt < timeoutMs) {
        const session = await client.sessions.get(sessionId);
        const idle = isIdle(session);
        if (!idle) sawActivity = true;
        if (idle && (sawActivity || Date.now() - startedAt >= 2_000)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Timeout waiting for agent to become idle');
}

async function withConnection<T>(client: PawsAgentClient, action: () => Promise<T>): Promise<T> {
    await client.connect();
    try {
        return await action();
    } finally {
        await client.disconnect();
    }
}

function writeResult(dependencies: CliDependencies, data: unknown, json: boolean | undefined, formatted: string): void {
    dependencies.stdout((json ? formatJson(data) : formatted) + '\n');
}

export function createCli(dependencies: CliDependencies = defaultDependencies()): Command {
    const { client } = dependencies;
    const program = new Command()
        .name('paws-agent')
        .description('CLI client for controlling Paws agents remotely')
        .version(packageMetadata.version)
        .exitOverride()
        .configureOutput({
            writeOut: value => dependencies.stdout(value),
            writeErr: value => dependencies.stderr(value),
        });

    program.command('auth').description('Manage authentication')
        .addCommand(new Command('login').description('Authenticate via QR code').action(dependencies.auth.login))
        .addCommand(new Command('logout').description('Clear stored credentials').action(dependencies.auth.logout))
        .addCommand(new Command('status').description('Show authentication status').action(dependencies.auth.status));

    program.command('machines').description('List all machines')
        .option('--active', 'Show only active machines').option('--json', 'Output as JSON')
        .action(async (options: { active?: boolean; json?: boolean }) => {
            const machines = await client.machines.list({ active: options.active });
            writeResult(dependencies, machines, options.json, formatMachineTable(machines));
        });

    program.command('list').description('List all sessions')
        .option('--active', 'Show only active sessions').option('--json', 'Output as JSON')
        .action(async (options: { active?: boolean; json?: boolean }) => {
            const sessions = await client.sessions.list({ active: options.active });
            writeResult(dependencies, sessions, options.json, formatSessionTable(sessions));
        });

    program.command('status').description('Get current session state')
        .argument('<session-id>', 'Session ID or prefix').option('--json', 'Output as JSON')
        .action(async (value: string, options: { json?: boolean }) => {
            const session = await resolveSession(client, value);
            writeResult(dependencies, session, options.json, formatSessionStatus(session));
        });

    program.command('spawn').description('Spawn a new session on a machine')
        .requiredOption('--machine <machine-id>', 'Machine ID or prefix')
        .option('--path <path>', 'Working directory path (defaults to machine home directory)')
        .option('--agent <agent>', `Agent to start (${SUPPORTED_AGENTS.join(', ')})`, value => {
            if (!SUPPORTED_AGENTS.includes(value as SupportedAgent)) throw new InvalidArgumentError(`--agent must be one of: ${SUPPORTED_AGENTS.join(', ')}`);
            return value as SupportedAgent;
        })
        .option('--create-dir', 'Allow creating the directory if it does not exist')
        .option('--json', 'Output as JSON')
        .action(async (options: { machine: string; path?: string; agent?: SupportedAgent; createDir?: boolean; json?: boolean }) => {
            const machine = await resolveMachine(client, options.machine);
            const directory = resolveRemotePath(options.path, machine);
            const result = await withConnection(client, () => client.sessions.spawn({
                machineId: machine.id,
                directory,
                agent: options.agent,
                approvedNewDirectoryCreation: options.createDir,
            }));
            const payload = { machineId: machine.id, directory, agent: options.agent ?? null, ...result };
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : `Directory approval required: ${result.directory}`);
            writeResult(dependencies, payload, options.json, `## Session Spawned\n\n- Machine ID: \`${machine.id}\`\n- Session ID: \`${result.sessionId}\`\n- Path: ${directory}`);
        });

    program.command('resume').description('Resume a session on its original machine')
        .argument('<session-id>', 'Session ID or prefix').option('--json', 'Output as JSON')
        .action(async (value: string, options: { json?: boolean }) => {
            const session = await resolveSession(client, value);
            const result = await withConnection(client, () => client.sessions.resume({ sessionId: session.id }));
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : `Directory approval required: ${result.directory}`);
            writeResult(dependencies, result, options.json, `## Session Resumed\n\n- Source Session ID: \`${session.id}\`\n- Resumed Session ID: \`${result.sessionId}\``);
        });

    program.command('send').description('Send a message to a session')
        .argument('<session-id>', 'Session ID or prefix').argument('<message>', 'Message text')
        .option('--yolo', 'Send with permissionMode=yolo').option('--wait', 'Wait for agent to become idle')
        .option('--json', 'Output as JSON')
        .action(async (value: string, message: string, options: { yolo?: boolean; wait?: boolean; json?: boolean }) => {
            const session = await resolveSession(client, value);
            const receipt = await client.messages.send({
                sessionId: session.id,
                text: message,
                meta: options.yolo ? { permissionMode: 'yolo' } : undefined,
            });
            if (options.wait) await waitForIdle(client, session.id, 300_000, true);
            writeResult(dependencies, receipt, options.json, `## Message Sent\n\n- Session ID: \`${session.id}\`\n- Local ID: \`${receipt.localId}\``);
        });

    program.command('history').description('Read message history')
        .argument('<session-id>', 'Session ID or prefix')
        .option('--limit <n>', 'Limit number of messages', value => {
            const limit = Number.parseInt(value, 10);
            if (!Number.isSafeInteger(limit) || limit <= 0) throw new InvalidArgumentError('--limit must be a positive integer');
            return limit;
        })
        .option('--json', 'Output as JSON')
        .action(async (value: string, options: { limit?: number; json?: boolean }) => {
            const session = await resolveSession(client, value);
            const messages = await client.messages.history(session.id, { limit: options.limit });
            writeResult(dependencies, messages, options.json, formatMessageHistory(messages));
        });

    program.command('approve').description('Approve a pending agent request')
        .argument('<session-id>', 'Session ID or prefix').argument('<request-id>', 'Request ID')
        .option('--json', 'Output as JSON')
        .action(async (value: string, requestId: string, options: { json?: boolean }) => {
            const session = await resolveSession(client, value);
            await withConnection(client, () => client.requests.approve({ sessionId: session.id, requestId }));
            const payload = { sessionId: session.id, requestId, approved: true };
            writeResult(dependencies, payload, options.json, `## Request Approved\n\n- Session ID: \`${session.id}\`\n- Request ID: \`${requestId}\``);
        });

    program.command('stop').description('Stop a session')
        .argument('<session-id>', 'Session ID or prefix')
        .action(async (value: string) => {
            const session = await resolveSession(client, value);
            await withConnection(client, () => client.sessions.stop(session.id));
            dependencies.stdout(`## Session Stopped\n\n- Session ID: \`${session.id}\`\n`);
        });

    program.command('wait').description('Wait for agent to become idle')
        .argument('<session-id>', 'Session ID or prefix')
        .option('--timeout <seconds>', 'Timeout in seconds', value => {
            const seconds = Number.parseInt(value, 10);
            if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new InvalidArgumentError('--timeout must be a positive integer');
            return seconds;
        }, 300)
        .action(async (value: string, options: { timeout: number }) => {
            const session = await resolveSession(client, value);
            await waitForIdle(client, session.id, options.timeout * 1_000);
            dependencies.stdout(`## Session Idle\n\n- Session ID: \`${session.id}\`\n`);
        });

    return program;
}

export async function runCli(argv: string[] = process.argv, dependencies?: CliDependencies): Promise<void> {
    const resolvedDependencies = dependencies ?? defaultDependencies();
    const program = createCli(resolvedDependencies);
    try {
        await program.parseAsync(argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.exitCode !== 0) process.exitCode = 2;
            return;
        }
        const message = error instanceof PawsAgentError && error.code === 'AUTH_REQUIRED'
            ? 'Not authenticated. Run `paws-agent auth login` first.'
            : error instanceof Error ? error.message : 'Operation failed';
        resolvedDependencies.stderr(message + '\n');
        process.exitCode = 1;
    } finally {
        await resolvedDependencies.client.dispose();
    }
}
