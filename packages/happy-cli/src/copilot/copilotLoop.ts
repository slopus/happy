/**
 * Copilot Loop - Local ↔ Remote mode switching
 * 
 * Modeled on claude/loop.ts. Alternates between:
 * - LOCAL: native `copilot` CLI in the terminal (PTY)
 * - REMOTE: ACP-based remote control from Happy mobile app
 * 
 * Session continuity is maintained via Copilot's disk-based session
 * storage (~/.copilot/session-state/<uuid>/). Both modes resume the
 * same session by ID.
 */

import { logger } from '@/ui/logger';
import { CopilotSession } from './copilotSession';
import { copilotLocalLauncher, type LauncherResult } from './copilotLocalLauncher';
import { copilotRemoteLauncher } from './copilotRemoteLauncher';
import { createCopilotSessionScanner } from './utils/copilotSessionScanner';

interface CopilotLoopOptions {
    session: CopilotSession;
    startingMode?: 'local' | 'remote';
    onModeChange: (mode: 'local' | 'remote') => void;
}

export async function copilotLoop(opts: CopilotLoopOptions): Promise<number> {
    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';

    // Create the scanner once and reuse it across mode switches.
    // This ensures processedIds persists — events written to events.jsonl
    // by Copilot after an ACP (remote) session ends are not replayed when
    // local mode resumes.
    const scanner = await createCopilotSessionScanner({
        onEnvelope: (envelope) => {
            logger.debug(`[copilotLocal] Sending envelope: role=${envelope.role}, ev.t=${envelope.ev.t}${envelope.ev.t === 'text' ? `, text=${(envelope.ev as any).text?.substring(0, 50)}` : ''}`);
            opts.session.client.sendSessionProtocolMessage(envelope);
        },
        onSessionIdDetected: (sessionId) => {
            if (opts.session.copilotSessionId !== sessionId) {
                opts.session.onCopilotSessionFound(sessionId);
            }
        },
    });

    try {
        while (true) {
            logger.debug(`[copilotLoop] Iteration with mode: ${mode}`);

            switch (mode) {
                case 'local': {
                    const result = await copilotLocalLauncher(opts.session, scanner);
                    switch (result.type) {
                        case 'switch':
                            mode = 'remote';
                            opts.onModeChange(mode);
                            break;
                        case 'exit':
                            return result.code;
                        default:
                            const _: never = result satisfies never;
                    }
                    break;
                }

                case 'remote': {
                    const reason = await copilotRemoteLauncher(opts.session);
                    switch (reason) {
                        case 'exit':
                            return 0;
                        case 'switch':
                            mode = 'local';
                            // Remote launcher closes the queue to unblock its wait loop.
                            // Reset it so local mode can receive new messages.
                            opts.session.queue.reset();
                            opts.onModeChange(mode);
                            break;
                        default:
                            const _: never = reason satisfies never;
                    }
                    break;
                }

                default: {
                    const _: never = mode satisfies never;
                }
            }
        }
    } finally {
        await scanner.cleanup();
    }
}
