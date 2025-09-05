import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { readSettings } from '@/persistence';
import { AgentState, Metadata } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import os from 'node:os';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { projectPath } from '@/projectPath';
import { resolve } from 'node:path';

/**
 * Main entry point for the codex command
 */
export async function runCodex(opts: {
    token: string;
    secret: Uint8Array;
}): Promise<void> {

    //
    // Define session
    //

    const sessionTag = randomUUID();
    const api = new ApiClient(opts.token, opts.secret);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexepcted since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    let state: AgentState = {
        controlledByUser: false,
    }
    let metadata: Metadata = {
        path: process.cwd(),
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: false,
        hostPid: process.pid,
        startedBy: 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'codex'
    };
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    const session = api.sessionSyncClient(response);
    const messageQueue = new MessageQueue2((mode) => '');
    session.onUserMessage((message) => {
        messageQueue.push(message.content.text, {});
    });
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    //
    // Abort handling
    //

    let abortController = new AbortController();
    async function handleAbort() {
        logger.debug('[Codex] Abort requested');
        try {
            abortController.abort();
            messageQueue.reset();
            permissionHandler.reset();
            logger.debug('[Codex] Abort completed');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    //
    // Start Context 
    //

    const client = new CodexMcpClient();
    const permissionHandler = new CodexPermissionHandler(session);
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        console.log(msg);
        if (msg.type === 'task_started') {
            if (!thinking) {
                console.log('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                console.log('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'agent_reasoning') {
            session.sendCodexMessage({
                type: 'reasoning',
                message: msg.text,
                id: randomUUID()
            });
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        if (msg.type === 'exec_command_end') {
            let { call_id, type, ...output } = msg;
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: output,
                id: randomUUID()
            });
        }
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
    });
    await client.connect();
    let wasCreated = false;
    try {
        while (true) {

            // Await message
            const message = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
            if (!message) {
                return;
            }
            try {
                if (!wasCreated) {
                    await client.startSession(
                        { prompt: message.message, sandbox: 'workspace-write' },
                        { signal: abortController.signal }
                    );
                    wasCreated = true;
                } else {
                    await client.continueSession(
                        message.message,
                        { signal: abortController.signal }
                    );
                }
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Reset permission handler
                permissionHandler.reset();
            }
        }

    } finally {
        await client.disconnect();
    }
}