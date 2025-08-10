import { ApiClient, ApiSessionClient } from "@/lib";
import { SessionScanner } from "./utils/sessionScanner";
import { MessageQueue2 } from "@/utils/MessageQueue2";
import { PermissionMode } from "@anthropic-ai/claude-code";

export class Session {
    readonly path: string;
    readonly logPath: string;
    readonly api: ApiClient;
    readonly client: ApiSessionClient;
    readonly queue: MessageQueue2<PermissionMode>;
    readonly claudeEnvVars?: Record<string, string>;
    readonly claudeArgs?: string[];
    readonly mcpServers: Record<string, any>;
    readonly _onModeChange: (mode: 'local' | 'remote') => void;

    sessionId: string | null;
    mode: 'local' | 'remote' = 'local';
    thinking: boolean = false;

    constructor(opts: {
        api: ApiClient,
        client: ApiSessionClient,
        path: string,
        logPath: string,
        sessionId: string | null,
        claudeEnvVars?: Record<string, string>,
        claudeArgs?: string[],
        mcpServers: Record<string, any>,
        messageQueue: MessageQueue2<PermissionMode>,
        onModeChange: (mode: 'local' | 'remote') => void,
    }) {
        this.path = opts.path;
        this.api = opts.api;
        this.client = opts.client;
        this.logPath = opts.logPath;
        this.sessionId = opts.sessionId;
        this.queue = opts.messageQueue;
        this.claudeEnvVars = opts.claudeEnvVars;
        this.claudeArgs = opts.claudeArgs;
        this.mcpServers = opts.mcpServers;
        this._onModeChange = opts.onModeChange;

        // Start keep alive
        this.client.keepAlive(this.thinking, this.mode);
        setInterval(() => {
            this.client.keepAlive(this.thinking, this.mode);
        }, 2000);
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

    onSessionFound = (sessionId: string) => {
        this.sessionId = sessionId;
    }
}