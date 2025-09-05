import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
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
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";

/**
 * Main entry point for the codex command with ink UI
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
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
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
    let shouldExit = false;
    
    async function handleAbort() {
        logger.debug('[Codex] Abort requested');
        try {
            abortController.abort();
            messageQueue.reset();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
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
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const client = new CodexMcpClient();
    const permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Callback to send messages directly from the processor
        session.sendCodexMessage(message);
    });
    client.setPermissionHandler(permissionHandler);
    client.setHandler((msg) => {
        logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);
        
        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`, 
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
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
        if (msg.type === 'patch_apply_begin') {
            // Handle the start of a patch operation
            let { call_id, auto_approved, changes } = msg;
            
            // Add UI feedback for patch operation
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
            
            // Send tool call message
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexPatch',
                callId: call_id,
                input: {
                    auto_approved,
                    changes
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_end') {
            // Handle the end of a patch operation
            let { call_id, stdout, stderr, success } = msg;
            
            // Add UI feedback for completion
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
            
            // Send tool call result message
            session.sendCodexMessage({
                type: 'tool-call-result',
                callId: call_id,
                output: {
                    stdout,
                    stderr,
                    success
                },
                id: randomUUID()
            });
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    });
    
    try {
        await client.connect();
        let wasCreated = false;
        
        while (!shouldExit) {
            // Display user messages in the UI
            const message = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
            if (!message || shouldExit) {
                break;
            }
            
            messageBuffer.addMessage(message.message, 'user');
            
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
                logger.warn('Error in codex session:', error);
                if (error instanceof Error && error.name === 'AbortError') {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
        }

    } finally {
        // Clean up
        await client.disconnect();
        
        // Clean up ink UI
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();
        
        logger.debug('[codex]: Cleanup completed');
    }
}