#!/usr/bin/env node

import { Command } from 'commander';
import { hostname } from 'node:os';
import { loadConfig } from './config';
import { requireCredentials } from './credentials';
import { authLogin, authLogout, authStatus } from './auth';
import { listSessions, listActiveSessions, createSession, getSessionMessages } from './api';
import { SessionClient } from './session';
import { formatSessionTable, formatSessionStatus, formatMessageHistory, formatJson } from './output';

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

        // Fetch sessions and find matching one by ID prefix
        const sessions = await listSessions(config, creds);
        const matches = sessions.filter(s => s.id.startsWith(sessionId));

        if (matches.length === 0) {
            console.error(`No session found matching "${sessionId}"`);
            process.exitCode = 1;
            return;
        }
        if (matches.length > 1) {
            console.error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
            process.exitCode = 1;
            return;
        }

        const session = matches[0];

        // Connect via Socket.IO to get live agent state, then disconnect
        const client = new SessionClient({
            sessionId: session.id,
            encryptionKey: session.encryption.key,
            encryptionVariant: session.encryption.variant,
            token: creds.token,
            serverUrl: config.serverUrl,
        });

        // Wait for a state-change event or a short timeout to get live data
        await new Promise<void>(resolve => {
            const timeout = setTimeout(() => {
                resolve();
            }, 3000);

            client.once('state-change', (data: { metadata: unknown; agentState: unknown }) => {
                clearTimeout(timeout);
                // Update session with live data
                session.metadata = data.metadata ?? session.metadata;
                session.agentState = data.agentState ?? session.agentState;
                resolve();
            });

            client.once('connect_error', () => {
                clearTimeout(timeout);
                // Fall back to data we already have from HTTP
                resolve();
            });
        });

        client.close();

        if (opts.json) {
            console.log(formatJson(session));
        } else {
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
            console.log(`Session created: ${session.id}`);
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

        // Resolve session by ID prefix
        const sessions = await listSessions(config, creds);
        const matches = sessions.filter(s => s.id.startsWith(sessionId));

        if (matches.length === 0) {
            console.error(`No session found matching "${sessionId}"`);
            process.exitCode = 1;
            return;
        }
        if (matches.length > 1) {
            console.error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
            process.exitCode = 1;
            return;
        }

        const session = matches[0];

        const client = new SessionClient({
            sessionId: session.id,
            encryptionKey: session.encryption.key,
            encryptionVariant: session.encryption.variant,
            token: creds.token,
            serverUrl: config.serverUrl,
        });

        client.sendMessage(message);

        if (opts.wait) {
            await client.waitForIdle();
        }

        client.close();

        if (opts.json) {
            console.log(formatJson({ sessionId: session.id, message, sent: true }));
        } else {
            console.log(`Message sent to session ${session.id}`);
        }
    });

program
    .command('history')
    .description('Read message history')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--limit <n>', 'Limit number of messages', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (sessionId: string, opts: { limit?: number; json?: boolean }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);

        // Resolve session by ID prefix
        const sessions = await listSessions(config, creds);
        const matches = sessions.filter(s => s.id.startsWith(sessionId));

        if (matches.length === 0) {
            console.error(`No session found matching "${sessionId}"`);
            process.exitCode = 1;
            return;
        }
        if (matches.length > 1) {
            console.error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
            process.exitCode = 1;
            return;
        }

        const session = matches[0];
        let messages = await getSessionMessages(config, creds, session.id);

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

        // Resolve session by ID prefix
        const sessions = await listSessions(config, creds);
        const matches = sessions.filter(s => s.id.startsWith(sessionId));

        if (matches.length === 0) {
            console.error(`No session found matching "${sessionId}"`);
            process.exitCode = 1;
            return;
        }
        if (matches.length > 1) {
            console.error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
            process.exitCode = 1;
            return;
        }

        const session = matches[0];

        const client = new SessionClient({
            sessionId: session.id,
            encryptionKey: session.encryption.key,
            encryptionVariant: session.encryption.variant,
            token: creds.token,
            serverUrl: config.serverUrl,
        });

        client.sendStop();
        client.close();

        console.log(`Stopped session ${session.id}`);
    });

program
    .command('wait')
    .description('Wait for agent to become idle')
    .argument('<session-id>', 'Session ID or prefix')
    .option('--timeout <seconds>', 'Timeout in seconds', parseInt, 300)
    .action(async (sessionId: string, opts: { timeout: number }) => {
        const config = loadConfig();
        const creds = requireCredentials(config);

        // Resolve session by ID prefix
        const sessions = await listSessions(config, creds);
        const matches = sessions.filter(s => s.id.startsWith(sessionId));

        if (matches.length === 0) {
            console.error(`No session found matching "${sessionId}"`);
            process.exitCode = 1;
            return;
        }
        if (matches.length > 1) {
            console.error(`Ambiguous session ID "${sessionId}" matches ${matches.length} sessions. Be more specific.`);
            process.exitCode = 1;
            return;
        }

        const session = matches[0];

        const client = new SessionClient({
            sessionId: session.id,
            encryptionKey: session.encryption.key,
            encryptionVariant: session.encryption.variant,
            token: creds.token,
            serverUrl: config.serverUrl,
        });

        try {
            await client.waitForIdle(opts.timeout * 1000);
            console.log(`Agent is idle for session ${session.id}`);
        } catch {
            console.error(`Timeout: agent did not become idle within ${opts.timeout} seconds`);
            process.exitCode = 1;
        } finally {
            client.close();
        }
    });

program.parse(process.argv);
