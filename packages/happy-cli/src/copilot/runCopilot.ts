/**
 * Copilot CLI Entry Point
 * 
 * Main entry point for `happy copilot`. Sets up the Happy session,
 * then runs the local ↔ remote mode switching loop.
 * 
 * Modeled on claude/runClaude.ts but simplified — most of the heavy
 * lifting is in copilotLoop.ts and the launchers.
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import { copilotLoop } from './copilotLoop';
import { CopilotSession, type CopilotMode } from './copilotSession';

export async function runCopilot(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    startingMode?: 'local' | 'remote';
}): Promise<void> {
    logger.debug('[COPILOT] ===== COPILOT MODE STARTING =====');

    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Validate daemon spawn requirements
    if (opts.startedBy === 'daemon' && opts.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode.');
    }

    connectionState.setBackend('Copilot');

    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) {
        throw new Error('No machine ID found in settings');
    }

    await api.getOrCreateMachine({
        machineId: settings.machineId,
        metadata: initialMachineMetadata,
    });

    const { state, metadata } = createSessionMetadata({
        flavor: 'copilot',
        machineId: settings.machineId,
        startedBy: opts.startedBy,
        sandbox: settings.sandboxConfig,
    });

    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (!response) {
        console.error('Failed to create Happy session (server unreachable)');
        process.exit(1);
    }

    logger.debug(`[COPILOT] Session created: ${response.id}`);

    // Notify daemon
    try {
        await notifyDaemonSessionStarted(response.id, metadata);
    } catch (error) {
        logger.debug('[COPILOT] Failed to report session to daemon:', error);
    }

    // Setup session client with offline reconnection
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            sessionClient = newSession;
        },
    });
    let sessionClient = initialSession;

    // Create message queue
    const messageQueue = new MessageQueue2<CopilotMode>((mode) => hashObject(mode));

    // Register global user message handler so that app messages in LOCAL mode
    // get pushed to the queue (triggering mode switch to remote).
    // The remote launcher also registers its own onUserMessage, which overrides
    // this one, but both do the same job.
    let currentPermissionMode: string | undefined;
    let currentModel: string | null | undefined;
    sessionClient.onUserMessage((message) => {
        if (typeof message.meta?.permissionMode === 'string') {
            currentPermissionMode = message.meta.permissionMode;
        }
        if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
            currentModel = message.meta.model ?? null;
        }
        if (!message.content.text) return;
        messageQueue.push(message.content.text, {
            permissionMode: currentPermissionMode,
            model: currentModel ?? undefined,
        });
    });

    // Prevent sleep on macOS
    startCaffeinate();

    // Create copilot session
    const copilotSession = new CopilotSession({
        api,
        client: sessionClient,
        path: workingDirectory,
        messageQueue,
        onModeChange: (mode) => {
            logger.debug(`[COPILOT] Mode changed to: ${mode}`);
            sessionClient.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: mode === 'local',
            }));
        },
    });

    // Set initial agent state
    sessionClient.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: opts.startingMode !== 'remote',
    }));

    try {
        const exitCode = await copilotLoop({
            session: copilotSession,
            startingMode: opts.startingMode ?? 'local',
            onModeChange: copilotSession.onModeChange,
        });

        if (exitCode !== 0) {
            process.exit(exitCode);
        }
    } finally {
        copilotSession.cleanup();
        reconnectionHandle?.cancel();
        stopCaffeinate();

        sessionClient.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
        }));
    }
}
