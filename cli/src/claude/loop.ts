import { ApiSessionClient } from "@/api/apiSession"
import { claudeRemote } from "./claudeRemote"
import { claudeLocal } from "./claudeLocal"
import { MessageQueue2 } from "@/utils/MessageQueue2"
import { logger } from "@/ui/logger"
import { createSessionScanner } from "./scanner/sessionScanner"
import type { OnAssistantResultCallback } from "@/ui/messageFormatter"
import type { InterruptController } from "./InterruptController"
import { render, type Instance } from 'ink'
import React from 'react'
import { RemoteModeDisplay } from '@/ui/ink/RemoteModeDisplay'
import { MessageBuffer } from '@/ui/ink/messageBuffer'

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

interface LoopOptions {
    path: string
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    onModeChange?: (mode: 'local' | 'remote') => void
    onProcessStart?: (mode: 'local' | 'remote') => void
    onProcessStop?: (mode: 'local' | 'remote') => void
    onThinkingChange?: (thinking: boolean) => void
    mcpServers?: Record<string, any>
    permissionPromptToolName?: string
    sessionScanner?: ReturnType<typeof createSessionScanner>
    session: ApiSessionClient
    onAssistantResult?: OnAssistantResultCallback
    interruptController?: InterruptController
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    onToolCallResolver?: (resolver: ((name: string, args: any) => string | null) | null) => void
    messageQueue?: MessageQueue2<PermissionMode>
}

/*
  When switching between modes or resuming sessions, we maintain a complete
  conversation history to properly deduplicate messages. This is necessary
  because Claude creates new session files when resuming with --resume,
  duplicating the conversation history in the new file.
  
  The new watcher uses full file reading and message deduplication to handle
  this correctly.
*/

export async function loop(opts: LoopOptions) {
    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    logger.debug(`[loop] Starting with permission mode: ${currentPermissionMode}`);
    let currentMessageQueue = opts.messageQueue || new MessageQueue2<PermissionMode>(
        mode => mode  // Simple string hasher since modes are already strings
    );
    let sessionId: string | null = null;
    let onMessage: (() => void) | null = null;
    let inkInstance: Instance | null = null;
    let messageBuffer: MessageBuffer | null = null;
    
    // Get log path for debug display
    const logPath = await logger.logFilePathPromise;

    const sessionScanner = opts.sessionScanner || createSessionScanner({
        workingDirectory: opts.path,
        onMessage: (message) => {
            opts.session.sendClaudeSessionMessage(message);
        }
    });

    // Handle user messages
    opts.session.onUserMessage((message) => {
        sessionScanner.onRemoteUserMessageForDeduplication(message.content.text);

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
        currentMessageQueue.push(message.content.text, messagePermissionMode);
        logger.debugLargeJson('User message pushed to queue:', message)

        if (onMessage) {
            onMessage();
        }
    });

    let onSessionFound = (newSessionId: string) => {
        sessionId = newSessionId;
        sessionScanner.onNewSession(newSessionId);
    }

    while (true) {
        logger.debug(`[loop] Starting loop iteration, queue size: ${currentMessageQueue.size()}, mode: ${mode}`);

        // Switch to remote mode if there are messages waiting
        if (currentMessageQueue.size() > 0) {
            if (mode !== 'remote') {
                mode = 'remote';
                if (opts.onModeChange) {
                    opts.onModeChange(mode);
                }
            }
        }

        // Start local mode
        if (mode === 'local') {
            let abortedOutside = false;
            const interactiveAbortController = new AbortController();
            opts.session.setHandler('switch', () => {
                if (!interactiveAbortController.signal.aborted) {
                    abortedOutside = true;
                    if (mode !== 'remote') {
                        mode = 'remote';
                        if (opts.onModeChange) {
                            opts.onModeChange(mode);
                        }
                    }
                    interactiveAbortController.abort();
                }
            });
            opts.session.setHandler('abort', () => {
                if (onMessage) {
                    onMessage();
                }
            });
            onMessage = () => {
                if (!interactiveAbortController.signal.aborted) {
                    abortedOutside = true;
                    if (mode !== 'remote') {
                        mode = 'remote';
                        if (opts.onModeChange) {
                            opts.onModeChange(mode);
                        }
                    }
                    opts.session.sendSessionEvent({ type: 'message', message: 'Inference aborted' });
                    interactiveAbortController.abort();
                }
                onMessage = null;
            };

            // Call onProcessStart before starting local mode
            try {
                if (opts.onProcessStart) {
                    opts.onProcessStart('local');
                }

                await claudeLocal({
                    path: opts.path,
                    sessionId: sessionId,
                    onSessionFound: onSessionFound,
                    onThinkingChange: opts.onThinkingChange,
                    abort: interactiveAbortController.signal,
                    claudeEnvVars: opts.claudeEnvVars,
                    claudeArgs: opts.claudeArgs,
                });
            } catch (e) {
                if (!interactiveAbortController.signal.aborted) {
                    opts.session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                // Call onProcessStop after local mode completes
                if (opts.onProcessStop) {
                    opts.onProcessStop('local');
                }
            }

            onMessage = null;
            if (!abortedOutside) {
                return;
            }
            if (mode !== 'local') {
                console.log('Switching to remote mode...');
            }
        }

        // Start remote mode
        if (mode === 'remote') {
            // Initialize Ink UI if not already initialized
            if (!inkInstance) {
                messageBuffer = new MessageBuffer();
                // Clear the screen before rendering
                console.clear();
                inkInstance = render(React.createElement(RemoteModeDisplay, { 
                    messageBuffer,
                    logPath: process.env.DEBUG ? logPath : undefined
                }), {
                    // Use alternate screen buffer to preserve terminal history
                    exitOnCtrlC: false,
                    patchConsole: false
                });
                logger.debug('[loop] Ink UI initialized for remote mode');
            }
            
            logger.debug('Starting ' + sessionId);
            const remoteAbortController = new AbortController();

            // Use the current queue for this session
            opts.session.setHandler('abort', () => {
                if (remoteAbortController && !remoteAbortController.signal.aborted) {
                    remoteAbortController.abort();
                }
            });
            const abortHandler = () => {
                logger.debug('[loop] abortHandler called - key press detected');
                if (remoteAbortController && !remoteAbortController.signal.aborted) {
                    logger.debug('[loop] Aborting remote controller');
                    if (mode !== 'local') {
                        mode = 'local';
                        if (opts.onModeChange) {
                            opts.onModeChange(mode);
                        }
                    }
                    
                    // Clean up Ink UI when switching to local mode
                    if (inkInstance) {
                        inkInstance.unmount();
                        inkInstance = null;
                        messageBuffer?.clear();
                        messageBuffer = null;
                        logger.debug('[loop] Ink UI unmounted for local mode switch');
                    }
                    
                    opts.session.sendSessionEvent({ type: 'message', message: 'Inference aborted' });
                    remoteAbortController.abort();
                } else {
                    logger.debug('[loop] Remote controller already aborted or null');
                }
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }
            };
            process.stdin.resume();
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.setEncoding("utf8");
            logger.debug('[loop] Attaching stdin abort handler');
            process.stdin.on('data', abortHandler);
            try {
                logger.debug(`Starting claudeRemote with messages: ${currentMessageQueue.size()}`);

                // Wait for messages and get as string
                logger.debug('[loop] Waiting for messages before starting claudeRemote...');
                const messageData = await currentMessageQueue.waitForMessagesAndGetAsString(remoteAbortController.signal);

                if (!messageData) {
                    // console.log('no message data');
                    console.log('[LOOP] No message received (queue closed or aborted), continuing loop');
                    logger.debug('[loop] No message received (queue closed or aborted), skipping remote mode');
                    continue;
                }

                // Update current permission mode from queue
                currentPermissionMode = messageData.mode;
                logger.debug(`[loop] Using permission mode from queue: ${currentPermissionMode}`);

                // Call onProcessStart before starting remote mode
                if (opts.onProcessStart) {
                    opts.onProcessStart('remote');
                }
                
                // Add status message to buffer
                if (messageBuffer) {
                    messageBuffer.addMessage('═'.repeat(40), 'status');
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                }

                // Emit permission mode change event before starting claudeRemote
                opts.session.sendSessionEvent({ type: 'permission-mode-changed', mode: currentPermissionMode });
                logger.debug(`[loop] Sent permission-mode-changed event to app: ${currentPermissionMode}`);

                await claudeRemote({
                    abort: remoteAbortController.signal,
                    sessionId: sessionId,
                    path: opts.path,
                    mcpServers: opts.mcpServers,
                    permissionPromptToolName: opts.permissionPromptToolName,
                    permissionMode: currentPermissionMode,
                    onSessionFound: onSessionFound,
                    onThinkingChange: opts.onThinkingChange,
                    message: messageData.message,
                    onAssistantResult: opts.onAssistantResult,
                    interruptController: opts.interruptController,
                    claudeEnvVars: opts.claudeEnvVars,
                    claudeArgs: opts.claudeArgs,
                    onToolCallResolver: opts.onToolCallResolver,
                    messageBuffer: messageBuffer,
                });

            } catch (e) {
                if (!remoteAbortController.signal.aborted) {
                    opts.session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                }
            } finally {
                remoteAbortController.abort(); // If process is still alive
                // Call onProcessStop after remote mode completes
                if (opts.onProcessStop) {
                    opts.onProcessStop('remote');
                }
                logger.debug('[loop] Removing stdin abort handler');
                process.stdin.off('data', abortHandler);
                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(false);
                }

                // MessageQueue2 automatically handles mode changes, no need to manually close/recreate
            }
            if (mode !== 'remote') {
                // Clean up Ink UI when exiting remote mode
                if (inkInstance) {
                    inkInstance.unmount();
                    inkInstance = null;
                    messageBuffer?.clear();
                    messageBuffer = null;
                    logger.debug('[loop] Ink UI unmounted after remote mode exit');
                }
                console.log('Switching back to good old claude...');
            }
        }
    }
}
