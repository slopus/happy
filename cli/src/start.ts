import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { loop } from '@/claude/loop';
import os from 'node:os';
import { AgentState, Metadata } from '@/api/types';
// @ts-ignore
import packageJson from '../package.json';
import { registerHandlers } from '@/api/handlers';
import { readSettings } from '@/persistence/persistence';
import { PermissionMode } from '@anthropic-ai/claude-code';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';

export interface StartOptions {
    model?: string
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    daemonSpawn?: boolean
}

export async function start(credentials: { secret: Uint8Array, token: string }, options: StartOptions = {}): Promise<void> {
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Validate daemon spawn requirements
    if (options.daemonSpawn && options.startingMode === 'local') {
        logger.debug('Daemon spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Daemon-spawned sessions cannot use local/interactive mode');
    }

    // Create session service
    const api = new ApiClient(credentials.token, credentials.secret);

    // Create a new session
    let state: AgentState = {};
    const settings = await readSettings() || { onboardingCompleted: false };
    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: settings.machineId
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    logger.debug(`Session created: ${response.id}`);

    // Output session ID for daemon to parse when spawned with --daemon-spawn
    if (options.daemonSpawn) {
        console.log(`daemon:sessionIdCreated:${response.id}`);
    }

    // Create realtime session
    const session = api.session(response);

    // Print log file path
    const logPath = await logger.logFilePathPromise;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Start caffeinate to prevent sleep on macOS
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.infoDeveloper('Sleep prevention enabled (macOS)');
    }

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<PermissionMode>(mode => mode);

    // Register all RPC handlers
    registerHandlers(session);

    // Forward messages to the queue
    let currentPermissionMode = options.permissionMode;
    session.onUserMessage((message) => {

        // Resolve permission mode from meta
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const validModes: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
            if (validModes.includes(message.meta.permissionMode as PermissionMode)) {
                messagePermissionMode = message.meta.permissionMode as PermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);

            } else {
                logger.debug(`[loop] Invalid permission mode received: ${message.meta.permissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Push with resolved permission mode
        messageQueue.push(message.content.text, messagePermissionMode || 'default');
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Create claude loop
    await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: options.permissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        onModeChange: (newMode) => {
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: false
            }));
        },
        mcpServers: {},
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs
    });

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop caffeinate before exiting
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    // Exit
    process.exit(0);
}