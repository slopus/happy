import { query, type Options, type SDKUserMessage, type SDKMessage, AbortError } from '@anthropic-ai/claude-code'
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
    const abortController = new AbortController();
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionPromptToolName: opts.permissionPromptToolName,
        executable: 'node',
        abortController: abortController,
    }

    // Query Claude
    let aborted = false;
    let response: AsyncGenerator<SDKMessage>;
    opts.abort.addEventListener('abort', () => {
        if (!aborted) {
            aborted = true;
            if (response) {
                (async () => {
                    try {
                        const r = await (response as any).interrupt();
                    } catch (e) {
                        // Ignore
                    }
                    abortController.abort();
                })();
            } else {
                abortController.abort();
            }
        }
    });
    response = query({
        prompt: opts.messages,
        abortController: abortController,
        options: sdkOptions,
    });

    printDivider();
    try {
        for await (const message of response) {
            // Always format and display the message
            formatClaudeMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                opts.onSessionFound(message.session_id);
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            // Ignore
        } else {
            throw e;
        }
    }
    printDivider();
}