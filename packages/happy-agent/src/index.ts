#!/usr/bin/env node

import { Command } from 'commander';
import { hostname } from 'node:os';
import { loadConfig } from './config';
import type { Config } from './config';
import { requireCredentials } from './credentials';
import type { Credentials } from './credentials';
import { authLogin, authLogout, authStatus } from './auth';
import { listSessions, listActiveSessions, createSession, getSessionMessages } from './api';
import type { DecryptedSession } from './api';
import { SessionClient } from './session';
import { formatSessionTable, formatSessionStatus, formatMessageHistory, formatJson } from './output';

// --- Helpers ---

async function resolveSession(config: Config, creds: Credentials, sessionId: string): Promise<DecryptedSession> {
    if (!sessionId || sessionId.trim().length === 0) {
        throw new Error('Session ID is required');
    }
    const sessions = await listSessions(config, creds);
    const matches = sessions.filter(s => s.id.startsWith(sessionId));
    if (matches.length === 0) {
        throw new Error(`No session found matching "${sessionId}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
    }
    return matches[0];
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
    .option('--wait', 'Wait for agent to become idle')
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, message: string, opts: { wait?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);
        const session = await resolveSession(config, creds, sessionId);

        const client = createClient(session, creds, config);
        try {
            await client.waitForConnect();
            client.sendMessage(message);

            if (opts.wait) {
                await client.waitForIdle();
            } else {
                // Delay to allow the Socket.IO event to flush before closing
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } finally {
            client.close();
        }

        if (opts.json) {
            console.log(formatJson({ sessionId: session.id, message, sent: true }));
        } else {
            console.log([
                '## Message Sent',
                '',
                `- Session ID: \`${session.id}\``,
                `- Waited For Idle: ${opts.wait ? 'yes' : 'no'}`,
            ].join('\n'));
        }
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

        const client = createClient(session, creds, config);
        try {
            await client.waitForConnect();
            client.sendStop();

            // Delay to allow the Socket.IO event to flush before closing
            await new Promise(resolve => setTimeout(resolve, 500));
        } finally {
            client.close();
        }

        console.log([
            '## Session Stopped',
            '',
            `- Session ID: \`${session.id}\``,
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
