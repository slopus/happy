#!/usr/bin/env node

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isMessageWithParts, SessionStreamMessageSchema, type SessionStreamMessage } from '@slopus/happy-sync';
import { loadConfig } from './config';
import type { Config } from './config';
import { requireCredentials } from './credentials';
import type { Credentials } from './credentials';
import { authLogin, authLogout, authStatus } from './auth';
import { listSessions, listActiveSessions, createSession, getSessionMessages, listMachines } from './api';
import type { DecryptedMachine, DecryptedSession, DecryptedMessage } from './api';
import { resumeSessionOnMachine, spawnSessionOnMachine, type SupportedAgent } from './machineRpc';
import { SessionClient } from './session';
import { formatMachineTable, formatSessionTable, formatSessionStatus, formatMessageHistory, formatJson } from './output';

// --- Helpers ---

const SUPPORTED_AGENTS: SupportedAgent[] = ['claude', 'codex', 'gemini', 'openclaw'];

type PendingPermission = {
    id: string;
    callId: string;
    tool: string;
    permission: string;
    patterns: string[];
    source: 'control' | 'tool';
};

function resolveByPrefix<T extends { id: string }>(items: T[], value: string, label: string): T {
    if (!value || value.trim().length === 0) {
        throw new Error(`${label} is required`);
    }
    const matches = items.filter(item => item.id.startsWith(value));
    if (matches.length === 0) {
        throw new Error(`No ${label.toLowerCase()} found matching "${value}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous ${label.toLowerCase()} "${value}" matches ${matches.length} records. Be more specific.`);
    }
    return matches[0];
}

async function resolveSession(config: Config, creds: Credentials, sessionId: string): Promise<DecryptedSession> {
    const sessions = await listSessions(config, creds);
    return resolveByPrefix(sessions, sessionId, 'Session ID');
}

async function resolveMachine(config: Config, creds: Credentials, machineId: string): Promise<DecryptedMachine> {
    const machines = await listMachines(config, creds);
    return resolveByPrefix(machines, machineId, 'Machine ID');
}

function createClient(session: DecryptedSession, creds: Credentials, config: Config): SessionClient {
    return new SessionClient({
        sessionId: session.id,
        encryptionKey: session.encryption.key,
        encryptionVariant: session.encryption.variant,
        token: creds.token,
        serverUrl: config.serverUrl,
        initialAgentState: session.agentState ?? null,
    });
}

function resolveRemotePath(rawPath: string | undefined, machine: DecryptedMachine): string {
    const metadata = (machine.metadata ?? {}) as { homeDir?: unknown };
    const homeDir = typeof metadata.homeDir === 'string' && metadata.homeDir.trim().length > 0
        ? metadata.homeDir
        : undefined;
    const path = rawPath ?? homeDir;

    if (!path) {
        throw new Error('Machine metadata does not include a home directory. Pass --path explicitly.');
    }

    if (path === '~') {
        if (!homeDir) {
            throw new Error('Machine metadata does not include a home directory, so `~` cannot be resolved. Pass an absolute --path.');
        }
        return homeDir;
    }
    if (path.startsWith('~/')) {
        if (!homeDir) {
            throw new Error('Machine metadata does not include a home directory, so `~/...` cannot be resolved. Pass an absolute --path.');
        }
        const normalizedHome = homeDir.endsWith('/') || homeDir.endsWith('\\')
            ? homeDir.slice(0, -1)
            : homeDir;
        const separator = normalizedHome.includes('\\') && !normalizedHome.includes('/')
            ? '\\'
            : '/';
        return join(normalizedHome, path.slice(2)).replaceAll('/', separator);
    }
    return path;
}

function resolveSessionMachineId(session: DecryptedSession): string {
    const metadata = (session.metadata ?? {}) as { machineId?: unknown };
    if (typeof metadata.machineId !== 'string' || metadata.machineId.trim().length === 0) {
        throw new Error(`Session ${session.id} is missing machine metadata and cannot be resumed.`);
    }
    return metadata.machineId;
}

function ensureMachineCanResume(machine: DecryptedMachine): void {
    const metadata = (machine.metadata ?? {}) as {
        resumeSupport?: {
            rpcAvailable?: unknown;
            happyAgentAuthenticated?: unknown;
        };
    };

    if (metadata.resumeSupport?.rpcAvailable === true) {
        return;
    }

    if (metadata.resumeSupport?.happyAgentAuthenticated === false) {
        throw new Error('Resume is unavailable on this machine. Run `happy-agent auth login` in that machine environment first.');
    }

    throw new Error('Resume RPC is unavailable on this machine right now.');
}

function readLocalMachineId(config: Config): string | null {
    const settingsPath = join(config.homeDir, 'settings.json');
    if (!existsSync(settingsPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { machineId?: unknown };
        return typeof parsed.machineId === 'string' && parsed.machineId.trim().length > 0
            ? parsed.machineId
            : null;
    } catch {
        return null;
    }
}

function isLocalMachine(config: Config, machine: DecryptedMachine): boolean {
    const localMachineId = readLocalMachineId(config);
    if (localMachineId && localMachineId === machine.id) {
        return true;
    }

    const metadata = (machine.metadata ?? {}) as { happyHomeDir?: unknown; host?: unknown };
    if (typeof metadata.happyHomeDir === 'string' && metadata.happyHomeDir === config.homeDir) {
        return true;
    }

    return typeof metadata.host === 'string' && metadata.host === hostname();
}

async function stopSessionViaLocalDaemon(machine: DecryptedMachine, sessionId: string): Promise<boolean> {
    const daemonState = (machine.daemonState ?? {}) as { httpPort?: unknown };
    const httpPort = daemonState.httpPort;
    if (typeof httpPort !== 'number') {
        return false;
    }

    try {
        const response = await fetch(`http://127.0.0.1:${httpPort}/stop-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
        });
        if (!response.ok) {
            return false;
        }

        const body = await response.json() as { success?: unknown };
        return body.success === true;
    } catch {
        return false;
    }
}

function parseSessionStreamMessages(messages: DecryptedMessage[]): SessionStreamMessage[] {
    const parsed: SessionStreamMessage[] = [];
    for (const message of messages) {
        const result = SessionStreamMessageSchema.safeParse(message.content);
        if (result.success) {
            parsed.push(result.data);
        }
    }
    return parsed;
}

function collectPendingPermissions(messages: DecryptedMessage[]): PendingPermission[] {
    const parsed = parseSessionStreamMessages(messages);
    const resolvedIds = new Set<string>();
    const resolvedCallIds = new Set<string>();
    const pending = new Map<string, PendingPermission>();

    for (const message of parsed) {
        if (!isMessageWithParts(message)) {
            if (message.type === 'permission-response') {
                resolvedIds.add(message.requestID);
                resolvedCallIds.add(message.callID);
            }
            continue;
        }

        for (const part of message.parts) {
            if (part.type === 'decision') {
                resolvedIds.add(part.permissionID);
                resolvedCallIds.add(part.targetCallID);
            }
        }
    }

    for (const message of parsed) {
        if (!isMessageWithParts(message)) {
            if (message.type !== 'permission-request') {
                continue;
            }

            if (resolvedIds.has(message.id) || resolvedCallIds.has(message.callID)) {
                continue;
            }

            pending.set(message.id, {
                id: message.id,
                callId: message.callID,
                tool: message.tool,
                permission: message.tool,
                patterns: message.patterns,
                source: 'control',
            });
            continue;
        }

        for (const part of message.parts) {
            if (part.type !== 'tool' || part.state.status !== 'blocked' || part.state.block.type !== 'permission') {
                continue;
            }

            const requestId = part.state.block.id;
            if (resolvedIds.has(requestId) || resolvedCallIds.has(part.callID)) {
                continue;
            }

            pending.set(requestId, {
                id: requestId,
                callId: part.callID,
                tool: part.tool,
                permission: part.state.block.permission,
                patterns: part.state.block.patterns,
                source: 'tool',
            });
        }
    }

    return [...pending.values()];
}

function collectPendingPermissionsFromAgentState(agentState: unknown): PendingPermission[] {
    if (agentState == null || typeof agentState !== 'object' || Array.isArray(agentState)) {
        return [];
    }

    const requests = (agentState as { requests?: unknown }).requests;
    if (requests == null || typeof requests !== 'object' || Array.isArray(requests)) {
        return [];
    }

    const pending: PendingPermission[] = [];
    for (const [callId, value] of Object.entries(requests as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }

        const request = value as { tool?: unknown; arguments?: Record<string, unknown> };
        const tool = typeof request.tool === 'string' ? request.tool : 'Unknown';
        const args = request.arguments ?? {};
        const pattern = typeof args.file_path === 'string'
            ? args.file_path
            : typeof args.path === 'string'
                ? args.path
                : typeof args.command === 'string'
                    ? args.command
                    : '';

        pending.push({
            id: callId,
            callId,
            tool,
            permission: tool,
            patterns: pattern ? [pattern] : [],
            source: 'tool',
        });
    }

    return pending;
}

function resolvePermissionRequest(
    pendingPermissions: PendingPermission[],
    requestId?: string,
): PendingPermission {
    if (pendingPermissions.length === 0) {
        throw new Error('No pending permission requests found for this session.');
    }

    if (!requestId) {
        if (pendingPermissions.length === 1) {
            return pendingPermissions[0];
        }

        const summary = pendingPermissions
            .map((permission) => `- ${permission.id} (${permission.tool}: ${permission.patterns.join(', ') || permission.permission})`)
            .join('\n');
        throw new Error(`Multiple pending permission requests found. Re-run with a request ID prefix:\n${summary}`);
    }

    const matches = pendingPermissions.filter((permission) => permission.id.startsWith(requestId));
    if (matches.length === 0) {
        throw new Error(`No pending permission request found matching "${requestId}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous permission request ID "${requestId}" matches ${matches.length} requests. Be more specific.`);
    }
    return matches[0];
}

// --- CLI ---

const program = new Command();

program
    .name('happy-agent')
    .description('CLI client for controlling Happy Coder agents remotely')
    .version('0.1.0');

program
    .command('auth')
    .description('Manage authentication')
    .addCommand(
        new Command('login').description('Authenticate via QR code').action(async () => {
            const config = loadConfig();
            await authLogin(config);
        })
    )
    .addCommand(
        new Command('logout').description('Clear stored credentials').action(async () => {
            const config = loadConfig();
            await authLogout(config);
        })
    )
    .addCommand(
        new Command('status').description('Show authentication status').action(async () => {
            const config = loadConfig();
            await authStatus(config);
        })
    );

program
    .command('machines')
    .description('List all machines')
    .option('--active', 'Show only active machines')
    .option('--json', 'Output as JSON')
    .action(async (opts: { active?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const machines = await listMachines(config, creds);
        const filtered = opts.active ? machines.filter(machine => machine.active) : machines;
        if (opts.json) {
            console.log(formatJson(filtered));
        } else {
            console.log(formatMachineTable(filtered));
        }
    });

program
    .command('list')
    .description('List all sessions')
    .option('--active', 'Show only active sessions')
    .option('--json', 'Output as JSON')
    .action(async (opts: { active?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const sessions = opts.active
            ? await listActiveSessions(config, creds)
            : await listSessions(config, creds);
        if (opts.json) {
            console.log(formatJson(sessions));
        } else {
            console.log(formatSessionTable(sessions));
        }
    });

program
    .command('status')
    .description('Get live session state')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        const client = createClient(session, creds, config);

        let liveData = false;
        try {
            // Wait for connection, then wait for a state-change event or a short timeout
            await new Promise<void>(resolve => {
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    client.removeAllListeners('state-change');
                    client.removeAllListeners('connect_error');
                    resolve();
                };

                const timeout = setTimeout(done, 3000);

                client.once('state-change', (data: { metadata: unknown; agentState: unknown }) => {
                    session.metadata = data.metadata ?? session.metadata;
                    session.agentState = data.agentState ?? session.agentState;
                    liveData = true;
                    done();
                });

                client.once('connect_error', () => {
                    done();
                });
            });
        } finally {
            client.close();
        }

        if (opts.json) {
            console.log(formatJson(session));
        } else {
            if (!liveData) {
                console.log('> Note: showing cached data (could not get live status).');
            }
            console.log(formatSessionStatus(session));
        }
    });

program
    .command('spawn')
    .description('Spawn a new session on a machine')
    .requiredOption('--machine <machine-id>', 'Machine ID or prefix')
    .option('--path <path>', 'Working directory path (defaults to machine home directory)')
    .option('--agent <agent>', `Agent to start (${SUPPORTED_AGENTS.join(', ')})`, (value: string) => {
        if (!SUPPORTED_AGENTS.includes(value as SupportedAgent)) {
            throw new Error(`--agent must be one of: ${SUPPORTED_AGENTS.join(', ')}`);
        }
        return value as SupportedAgent;
    })
    .option('--create-dir', 'Allow creating the directory if it does not exist')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
        machine: string;
        path?: string;
        agent?: SupportedAgent;
        createDir?: boolean;
        json?: boolean;
    }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const machine = await resolveMachine(config, creds, opts.machine);
        const directory = resolveRemotePath(opts.path, machine);

        const result = await spawnSessionOnMachine(config, machine, creds.token, {
            directory,
            approvedNewDirectoryCreation: opts.createDir,
            agent: opts.agent,
        });

        const payload = {
            machineId: machine.id,
            directory,
            agent: opts.agent ?? null,
            ...result,
        };

        if (opts.json) {
            console.log(formatJson(payload));
            if (result.type !== 'success') {
                process.exitCode = 1;
            }
            return;
        }

        switch (result.type) {
            case 'success':
                console.log([
                    '## Session Spawned',
                    '',
                    `- Machine ID: \`${machine.id}\``,
                    `- Session ID: \`${result.sessionId}\``,
                    `- Path: ${directory}`,
                    `- Agent: ${opts.agent ?? 'default'}`,
                ].join('\n'));
                break;
            case 'requestToApproveDirectoryCreation':
                throw new Error(`The directory '${result.directory}' does not exist. Re-run with --create-dir to allow creating it.`);
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

program
    .command('resume')
    .description('Resume a session on its original machine')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const machineId = resolveSessionMachineId(session);
        const machine = await resolveMachine(config, creds, machineId);
        ensureMachineCanResume(machine);

        const result = await resumeSessionOnMachine(config, machine, creds.token, session.id);
        const payload = {
            sourceSessionId: session.id,
            machineId: machine.id,
            ...result,
        };

        if (opts.json) {
            console.log(formatJson(payload));
            if (result.type !== 'success') {
                process.exitCode = 1;
            }
            return;
        }

        switch (result.type) {
            case 'success':
                console.log([
                    '## Session Resumed',
                    '',
                    `- Machine ID: \`${machine.id}\``,
                    `- Source Session ID: \`${session.id}\``,
                    `- Resumed Session ID: \`${result.sessionId}\``,
                ].join('\n'));
                break;
            case 'requestToApproveDirectoryCreation':
                throw new Error(`Resume unexpectedly requested directory creation for '${result.directory}'. Resume should reuse the saved path.`);
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

program
    .command('create')
    .description('Create a new session')
    .requiredOption('--tag <tag>', 'Session tag')
    .option('--path <path>', 'Working directory path')
    .option('--json', 'Output as JSON')
    .action(async (opts: { tag: string; path?: string; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const metadata = {
            tag: opts.tag,
            path: opts.path ?? process.cwd(),
            host: hostname(),
        };
        const session = await createSession(config, creds, {
            tag: opts.tag,
            metadata,
        });
        if (opts.json) {
            console.log(formatJson(session));
        } else {
            console.log([
                '## Session Created',
                '',
                `- Session ID: \`${session.id}\``,
            ].join('\n'));
        }
    });

program
    .command('send')
    .description('Send a message to a session')
    .argument('<session-id>', 'Session ID or prefix')
    .argument('<message>', 'Message text')
    .option('--yolo', 'Send with permissionMode=yolo')
    .option('--wait', 'Wait for agent to become idle')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, message: string, opts: { yolo?: boolean; wait?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const permissionMode = opts.yolo ? 'yolo' : null;

        const client = createClient(session, creds, config);
        try {
            await client.waitForConnect();
            const completion = opts.wait ? client.waitForTurnCompletion() : null;
            client.sendMessage(message, permissionMode ? { permissionMode } : undefined);

            if (completion) {
                await completion;
            } else {
                // Delay to allow the Socket.IO event to flush before closing
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } finally {
            client.close();
        }

        if (opts.json) {
            console.log(formatJson({ sessionId: session.id, message, sent: true, permissionMode }));
        } else {
            console.log([
                '## Message Sent',
                '',
                `- Session ID: \`${session.id}\``,
                `- Permission Mode: ${permissionMode ?? 'default'}`,
                `- Waited For Idle: ${opts.wait ? 'yes' : 'no'}`,
            ].join('\n'));
        }
    });

program
    .command('approve')
    .description('Approve a pending permission request')
    .argument('<session-id>', 'Session ID or prefix')
    .argument('[request-id]', 'Permission request ID or prefix')
    .option('--always', 'Approve for the rest of the session')
    .option('--json', 'Output as JSON')
    .action(async (
        sessionId: string,
        requestId: string | undefined,
        opts: { always?: boolean; json?: boolean },
    ) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        const messages = await getSessionMessages(config, creds, session.id, session.encryption);
        const pendingPermissions = collectPendingPermissions(messages);
        if (pendingPermissions.length === 0) {
            pendingPermissions.push(...collectPendingPermissionsFromAgentState(session.agentState));
        }
        const permission = resolvePermissionRequest(pendingPermissions, requestId);
        const decision = opts.always ? 'always' : 'once';

        const client = createClient(session, creds, config);
        try {
            await client.waitForConnect();
            client.sendPermissionDecision({
                requestId: permission.id,
                callId: permission.callId,
                decision,
            });
            await new Promise(resolve => setTimeout(resolve, 500));
        } finally {
            client.close();
        }

        const payload = {
            sessionId: session.id,
            requestId: permission.id,
            callId: permission.callId,
            decision,
            tool: permission.tool,
        };

        if (opts.json) {
            console.log(formatJson(payload));
            return;
        }

        console.log([
            '## Permission Approved',
            '',
            `- Session ID: \`${session.id}\``,
            `- Request ID: \`${permission.id}\``,
            `- Tool: ${permission.tool}`,
            `- Decision: ${decision}`,
        ].join('\n'));
    });

program
    .command('history')
    .description('Read message history')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--limit <n>', 'Limit number of messages', (v: string) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n <= 0) throw new Error('--limit must be a positive integer');
        return n;
    })
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { limit?: number; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        let messages = await getSessionMessages(config, creds, session.id, session.encryption);

        // Sort chronologically by createdAt
        messages.sort((a, b) => a.createdAt - b.createdAt);

        // Apply limit
        if (opts.limit && opts.limit > 0) {
            messages = messages.slice(-opts.limit);
        }

        if (opts.json) {
            console.log(formatJson(messages));
        } else {
            console.log(formatMessageHistory(messages));
        }
    });

program
    .command('stop')
    .description('Stop a session')
    .argument('<session-id>', 'Session ID or prefix')
    .action(async (sessionId: string) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);
        let stopMethod: 'local-daemon-http' | 'session-socket' = 'session-socket';

        const machineId = (() => {
            try {
                return resolveSessionMachineId(session);
            } catch {
                return null;
            }
        })();

        if (machineId) {
            const machine = await resolveMachine(config, creds, machineId);
            if (isLocalMachine(config, machine) && await stopSessionViaLocalDaemon(machine, session.id)) {
                stopMethod = 'local-daemon-http';
            }
        }

        if (stopMethod === 'session-socket') {
            const client = createClient(session, creds, config);
            try {
                await client.waitForConnect();
                client.sendStop();

                // Delay to allow the Socket.IO event to flush before closing
                await new Promise(resolve => setTimeout(resolve, 500));
            } finally {
                client.close();
            }
        }

        console.log([
            '## Session Stopped',
            '',
            `- Session ID: \`${session.id}\``,
            `- Method: ${stopMethod}`,
        ].join('\n'));
    });

program
    .command('wait')
    .description('Wait for agent to become idle')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => {
        const n = parseInt(v, 10);
        if (isNaN(n) || n <= 0) throw new Error('--timeout must be a positive integer');
        return n;
    }, 300)
    .action(async (sessionId: string, opts: { timeout: number }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        const client = createClient(session, creds, config);
        try {
            await client.waitForConnect();
            await client.waitForIdle(opts.timeout * 1000);
            console.log([
                '## Session Idle',
                '',
                `- Session ID: \`${session.id}\``,
            ].join('\n'));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(msg);
            process.exitCode = 1;
        } finally {
            client.close();
        }
    });

program.parseAsync(process.argv).catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
