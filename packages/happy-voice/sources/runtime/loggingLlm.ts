import { DEFAULT_API_CONNECT_OPTIONS, type APIConnectOptions, llm } from '@livekit/agents';
import { logError, logInfo } from './log';

interface ChatInvocation {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
}

interface WrappedToolCall {
    callId: string;
    name: string;
    args: string;
}

function safeJsonClone<T>(value: T): T | string {
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch (error) {
        return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
    }
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch (error) {
        return JSON.stringify({
            serializationError: error instanceof Error ? error.message : String(error),
        });
    }
}

function dumpToolSchema(toolCtx?: llm.ToolContext) {
    if (!toolCtx) {
        return [];
    }

    return Object.entries(toolCtx).map(([name, tool]) => {
        let parameters: unknown = null;
        try {
            parameters = llm.toJsonSchema((tool as any).parameters, true, false);
        } catch (error) {
            parameters = `[schema_error: ${error instanceof Error ? error.message : String(error)}]`;
        }
        return {
            name,
            description: (tool as any).description ?? '',
            parameters,
        };
    });
}

class LoggingLLMStream extends llm.LLMStream {
    constructor(
        private readonly innerLLM: llm.LLM,
        private readonly logTag: string,
        private readonly invocation: ChatInvocation,
    ) {
        super(innerLLM, {
            chatCtx: invocation.chatCtx,
            toolCtx: invocation.toolCtx,
            connOptions: invocation.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
        });
    }

    protected async run(): Promise<void> {
        const requestPayload = {
            tag: this.logTag,
            model: this.innerLLM.model,
            providerLabel: this.innerLLM.label(),
            connOptions: this.invocation.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
            parallelToolCalls: this.invocation.parallelToolCalls,
            toolChoice: this.invocation.toolChoice,
            extraKwargs: safeJsonClone(this.invocation.extraKwargs ?? {}),
            tools: safeJsonClone(dumpToolSchema(this.invocation.toolCtx)),
            chatContext: safeJsonClone(this.invocation.chatCtx.toJSON({
                excludeImage: true,
                excludeAudio: true,
                excludeTimestamp: false,
                excludeFunctionCall: false,
            })),
        };
        logInfo('LLM request payload', safeJsonStringify(requestPayload));

        const stream = this.innerLLM.chat({
            chatCtx: this.invocation.chatCtx,
            toolCtx: this.invocation.toolCtx,
            connOptions: this.invocation.connOptions,
            parallelToolCalls: this.invocation.parallelToolCalls,
            toolChoice: this.invocation.toolChoice,
            extraKwargs: this.invocation.extraKwargs,
        });

        let responseText = '';
        const toolCalls = new Map<string, WrappedToolCall>();

        try {
            for await (const chunk of stream) {
                const delta = chunk.delta;
                if (delta?.content) {
                    responseText += delta.content;
                }
                for (const toolCall of delta?.toolCalls ?? []) {
                    toolCalls.set(toolCall.callId, {
                        callId: toolCall.callId,
                        name: toolCall.name,
                        args: toolCall.args,
                    });
                }
                this.queue.put(chunk);
            }
        } catch (error) {
            logError('LLM stream failed', {
                tag: this.logTag,
                model: this.innerLLM.model,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }

        const responsePayload = {
            tag: this.logTag,
            model: this.innerLLM.model,
            text: responseText,
            toolCalls: [...toolCalls.values()],
        };
        logInfo('LLM response payload', safeJsonStringify(responsePayload));
    }
}

class LoggingLLM extends llm.LLM {
    constructor(
        private readonly innerLLM: llm.LLM,
        private readonly logTag: string,
    ) {
        super();
    }

    label(): string {
        return this.innerLLM.label();
    }

    get model(): string {
        return this.innerLLM.model;
    }

    prewarm(): void {
        this.innerLLM.prewarm();
    }

    async aclose(): Promise<void> {
        await this.innerLLM.aclose();
    }

    chat(invocation: ChatInvocation): llm.LLMStream {
        return new LoggingLLMStream(this.innerLLM, this.logTag, invocation);
    }
}

const wrappedLLMs = new Map<string, llm.LLM>();

export function withLLMLogging(innerLLM: llm.LLM, logTag: string): llm.LLM {
    const cacheKey = `${logTag}:${innerLLM.model}:${innerLLM.label()}`;
    const existing = wrappedLLMs.get(cacheKey);
    if (existing) {
        return existing;
    }

    const wrapped = new LoggingLLM(innerLLM, logTag);
    wrappedLLMs.set(cacheKey, wrapped);
    return wrapped;
}
