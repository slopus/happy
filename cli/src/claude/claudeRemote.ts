import { query, type Options, SDKUserMessage } from '@anthropic-ai/claude-code'

export async function claudeRemote(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    permissionPromptToolName?: string,
    onSessionFound: (id: string) => void,
    messages: AsyncIterable<SDKUserMessage>
}) {

    // Prepare SDK options
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: opts.sessionId ?? undefined,
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
    for await (const message of response) {
        if (message.type === 'system') {
            if (message.subtype === 'init') {
                opts.onSessionFound(message.session_id);
            }
        }
    }
}