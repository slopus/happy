import { authGetToken, generateAppUrl } from '@/api/auth';
import { readSettings, writeSettings, readPrivateKey, writePrivateKey } from '@/persistence';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { displayQRCode } from '@/ui/qrcode';
import { basename } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { loop } from '@/claude/loop';
import os from 'node:os';
import chalk from 'chalk';
import { encodeBase64Url } from '@/api/encryption';
import { AgentState, Metadata } from '@/api/types';
import { startPermissionServerV2 } from '@/claude/mcp/startPermissionServerV2';

export interface StartOptions {
    model?: string
    permissionMode?: 'auto' | 'default' | 'plan'
}

export async function start(options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const projectName = basename(workingDirectory);
    const sessionTag = randomUUID();

    // Check onboarding
    const settings = await readSettings();
    const needsOnboarding = !settings || !settings.onboardingCompleted;

    // if (needsOnboarding) {
    // Show onboarding
    logger.info('\n' + chalk.bold.green('🎉 Welcome to Happy CLI!'));
    logger.info('\nHappy is an open-source, end-to-end encrypted wrapper around Claude Code');
    logger.info('that allows you to start a regular Claude terminal session with the `happy` command.\n');

    if (process.platform === 'darwin') {
        logger.info(chalk.yellow('💡 Tip for macOS users:'));
        logger.info('   Install Amphetamine to prevent your Mac from sleeping during sessions:');
        logger.info('   https://apps.apple.com/us/app/amphetamine/id937984704?mt=12\n');
        logger.info('   You can even close your laptop completely while running Amphetamine');
        logger.info('   and connect through hotspot to your phone for coding on the go!\n');
    }
    // }

    // Get or create secret key
    let secret = await readPrivateKey();
    if (!secret) {
        secret = new Uint8Array(randomBytes(32));
        await writePrivateKey(secret);
    }
    logger.info('Secret key loaded');

    // Authenticate with server
    const token = await authGetToken(secret);
    logger.info('Authenticated with handy server');

    // Create session service
    const api = new ApiClient(token, secret);

    // Create a new session
    let state: AgentState = {};
    let metadata: Metadata = { path: workingDirectory, host: os.hostname() };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.info(`Session created: ${response.id}`);

    // Show QR code during onboarding
    // if (needsOnboarding) {
    const handyUrl = generateAppUrl(secret);
    displayQRCode(handyUrl);
    // Display secret for manual entry
    const secretBase64Url = encodeBase64Url(secret);
    logger.info(`Or manually enter this code: ${secretBase64Url}`);

    logger.info('\n' + chalk.bold('Press Enter to continue...'));
    await new Promise<void>((resolve) => {
        process.stdin.once('data', () => resolve());
    });

    // Save onboarding completed
    await writeSettings({ onboardingCompleted: true });
    // }

    // Create realtime session
    const session = api.session(response);

    // Start MCP permission server
    let requests = new Map<string, (response: { approved: boolean, reason?: string }) => void>();
    const permissionServer = await startPermissionServerV2((request) => {
        const id = randomUUID();
        let promise = new Promise<{ approved: boolean, reason?: string }>((resolve) => { requests.set(id, resolve); });
        logger.info('Permission request' + id + ' ' + JSON.stringify(request));
        session.updateAgentState((currentState) => ({
            ...currentState,
            requests: {
                ...currentState.requests,
                [id]: {
                    tool: request.name,
                    arguments: request.arguments,
                }
            }
        }));
        return promise;
    });
    session.setHandler<{ id: string, approved: boolean, reason?: string }, void>('permission', (message) => {
        logger.info('Permission response' + JSON.stringify(message));
        const id = message.id;
        const resolve = requests.get(id);
        if (resolve) {
            resolve({ approved: message.approved, reason: message.reason });
        }
        session.updateAgentState((currentState) => {
            let r = { ...currentState.requests };
            delete r[id];
            return ({
                ...currentState,
                requests: r,
            });
        });
    });

    // Session keep alive
    let thinking = false;
    const pingInterval = setInterval(() => {
        session.keepAlive(thinking);
    }, 15000); // Ping every 15 seconds


    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        mcpServers: {
            'permission': {
                type: 'http' as const,
                url: permissionServer.url,
            }
        },
        permissionPromptToolName: 'mcp__permission__' + permissionServer.toolName,
        onThinking: (t) => {
            thinking = t;
            session.keepAlive(t);
        },
        session
    });

    // Handle graceful shutdown
    logger.info('Shutting down...')

    // Stop ping interval
    clearInterval(pingInterval);

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.info('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.info('Closing session...');
    await session.close();

    // Exit
    process.exit(0);
}