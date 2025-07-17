import { query, type Options, type SDKUserMessage, type SDKMessage } from '@anthropic-ai/claude-code'
import { formatClaudeMessage, printDivider } from '@/ui/messageFormatter'
import { claudeCheckSession } from './claudeCheckSession';
import { logger } from '@/ui/logger';

export async function claudeRemote(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    onSessionFound: (id: string) => void,
    messages: AsyncIterable<SDKUserMessage>
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }

    // Prepare SDK options
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
    }

    // Query Claude
    const abortController = new AbortController();
    opts.abort.addEventListener('abort', () => {
        abortController.abort();
    });
    const response = query({
        prompt: opts.messages,
        abortController: abortController,
        options: sdkOptions
    });
    printDivider();
    for await (const message of response) {
        // Always format and display the message
        formatClaudeMessage(message);

        // Handle special system messages
        if (message.type === 'system' && message.subtype === 'init') {
            opts.onSessionFound(message.session_id);
        }
    }
    printDivider();
}