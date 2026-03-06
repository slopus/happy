/**
 * Copilot Session State
 * 
 * Tracks session state across local ↔ remote mode switches.
 * Modeled on claude/session.ts but simplified for Copilot.
 */

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { logger } from '@/ui/logger';

export interface CopilotMode {
    permissionMode?: string;
    model?: string;
}

export class CopilotSession {
    readonly path: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<CopilotMode>;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;

    /** Copilot CLI session ID (UUID from ~/.copilot/session-state/) */
    copilotSessionId: string | null = null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;

    private keepAliveInterval: NodeJS.Timeout;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        messageQueue: MessageQueue2<CopilotMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
    }) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.queue = opts.messageQueue;
        this._onModeChange = opts.onModeChange;

        this.client.keepAlive(this.thinking, this.mode);
        this.keepAliveInterval = setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
    }

    cleanup = (): void => {
        clearInterval(this.keepAliveInterval);
        logger.debug('[CopilotSession] Cleaned up resources');
    }

    onThinkingChange = (thinking: boolean) => {
        this.thinking = thinking;
        this.client.keepAlive(thinking, this.mode);
    }

    onModeChange = (mode: 'local' | 'remote') => {
        this.mode = mode;
        this.client.keepAlive(this.thinking, mode);
        this._onModeChange(mode);
    }

    /** Called when Copilot session ID is discovered (from ACP or filesystem) */
    onCopilotSessionFound = (sessionId: string) => {
        this.copilotSessionId = sessionId;
        this.client.updateMetadata((metadata) => ({
            ...metadata,
            copilotSessionId: sessionId,
        }));
        logger.debug(`[CopilotSession] Copilot session ID: ${sessionId}`);
    }
}
