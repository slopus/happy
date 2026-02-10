import { llm, type APIConnectOptions } from '@livekit/agents';
import { tryGetCannedToolResponse } from './cannedSpeech';
import { logInfo } from './log';
import { loadAndRenderPromptFile } from './prompts';
import {
    extractRecentAppContext,
    extractRecentVoiceMessages,
    looksLikeAppContextUpdate,
} from './contextWindow';

class CannedLLMStream extends llm.LLMStream {
    constructor(
        parentLlm: llm.LLM,
        chatCtx: llm.ChatContext,
        private readonly text: string,
    ) {
        super(parentLlm, { chatCtx, connOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 5_000 } });
    }

    protected async run(): Promise<void> {
        this.queue.put({ id: 'canned', delta: { role: 'assistant', content: this.text } });
        this.queue.close();
    }
}

type ChatInvocation = {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
};

type PromptedLlmConfig = {
    mainPromptFile: string;
    toolFollowupPromptFile: string;
    languagePreference?: string;
    appSessionId?: string;
    getAppSessionId?: () => string;
    maxRecentVoiceMessages: number;
    maxRecentAppContextMessages: number;
    maxRecentChars: number;
    getRecentAppContext?: () => string;
};

function findLatestToolOutput(chatCtx: llm.ChatContext): { toolName: string; toolResult: string } | null {
    for (let i = chatCtx.items.length - 1; i >= 0; i--) {
        const item = chatCtx.items[i];
        if (!item) continue;
        if (item.type !== 'function_call_output') continue;
        const name = (item as unknown as { name?: string }).name;
        const output = (item as unknown as { output?: string }).output;
        return {
            toolName: typeof name === 'string' ? name : 'unknown',
            toolResult: typeof output === 'string' ? output : '',
        };
    }
    return null;
}

function isToolFollowupCall(chatCtx: llm.ChatContext): boolean {
    for (let i = chatCtx.items.length - 1; i >= 0; i--) {
        const item = chatCtx.items[i];
        if (!item) continue;
        if (item.type === 'message') {
            if (item.role === 'system' || item.role === 'developer') {
                continue;
            }
            return false;
        }
        if (item.type === 'function_call_output' || item.type === 'function_call') {
            return true;
        }
        return false;
    }
    return false;
}

function replaceInstructions(chatCtx: llm.ChatContext, newSystemPrompt: string): void {
    const items = chatCtx.items;
    for (const item of items) {
        if (item.type !== 'message') continue;
        if (item.role !== 'system') continue;
        item.content = [newSystemPrompt];
        return;
    }
    chatCtx.addMessage({ role: 'system', content: [newSystemPrompt] });
}

function stripAppContextUpdates(chatCtx: llm.ChatContext): void {
    const items = chatCtx.items;
    const kept: llm.ChatItem[] = [];
    let firstSystemKept = false;

    for (const item of items) {
        if (item.type !== 'message') {
            kept.push(item);
            continue;
        }

        if (item.role === 'system' && !firstSystemKept) {
            kept.push(item);
            firstSystemKept = true;
            continue;
        }

        if (looksLikeAppContextUpdate(item)) {
            continue;
        }

        kept.push(item);
    }

    chatCtx.items = kept;
}

function minimizeChatContext(chatCtx: llm.ChatContext, opts?: { keepLastUser?: boolean }): void {
    const keepLastUser = opts?.keepLastUser !== false;
    let systemItem: llm.ChatItem | null = null;
    let lastUserItem: llm.ChatItem | null = null;

    for (const item of chatCtx.items) {
        if (item.type === 'message' && item.role === 'system' && !systemItem) {
            systemItem = item;
        }
        if (item.type === 'message' && item.role === 'user') {
            lastUserItem = item;
        }
    }

    const kept: llm.ChatItem[] = [];
    if (systemItem) kept.push(systemItem);
    if (keepLastUser && lastUserItem && lastUserItem !== systemItem) kept.push(lastUserItem);

    // Provider adapters typically expect at least one user message; add a tiny one if missing.
    if (!kept.some((item) => item.type === 'message' && item.role === 'user')) {
        kept.push(llm.ChatMessage.create({ role: 'user', content: ['Continue'] }));
    }

    chatCtx.items = kept;
}

export class PromptedLLM extends llm.LLM {
    constructor(
        private readonly innerLLM: llm.LLM,
        private readonly config: PromptedLlmConfig,
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
        const chatCtx = invocation.chatCtx.copy();

        const toolFollowup = isToolFollowupCall(chatCtx);
        const recentVoiceMessages = extractRecentVoiceMessages({
            chatCtx,
            maxMessages: this.config.maxRecentVoiceMessages,
            maxChars: this.config.maxRecentChars,
            excludeLatestUserMessage: !toolFollowup,
        });
        const recentAppContextFromChat = extractRecentAppContext({
            chatCtx,
            maxMessages: this.config.maxRecentAppContextMessages,
            maxChars: this.config.maxRecentChars,
        });
        const appContextOverride = this.config.getRecentAppContext?.();
        const recentAppContext =
            typeof appContextOverride === 'string' && appContextOverride.trim().length > 0
                ? appContextOverride
                : recentAppContextFromChat;
        const currentAppSessionId = this.config.getAppSessionId?.() || this.config.appSessionId || '';
        const toolOutput = toolFollowup ? findLatestToolOutput(chatCtx) : null;

        // Short-circuit: for predictable tool results, return a canned response without calling LLM.
        if (toolFollowup && toolOutput) {
            const canned = tryGetCannedToolResponse(
                toolOutput.toolName,
                toolOutput.toolResult,
                this.config.languagePreference || '',
            );
            if (canned) {
                logInfo('PromptedLLM.chat() canned response', {
                    toolName: toolOutput.toolName,
                    canned,
                });
                return new CannedLLMStream(this.innerLLM, chatCtx, canned);
            }
        }

        const systemPrompt = loadAndRenderPromptFile(
            toolFollowup ? this.config.toolFollowupPromptFile : this.config.mainPromptFile,
            {
                language_preference: this.config.languagePreference || '',
                app_session_id: currentAppSessionId,
                recent_voice_messages: recentVoiceMessages,
                recent_app_context: recentAppContext,
                tool_name: toolOutput?.toolName || '',
                tool_result: toolOutput?.toolResult || '',
            },
        );

        replaceInstructions(chatCtx, systemPrompt);
        stripAppContextUpdates(chatCtx);
        minimizeChatContext(chatCtx, toolFollowup ? { keepLastUser: false } : undefined);

        logInfo('PromptedLLM.chat()', {
            toolFollowup,
            itemCount: chatCtx.items.length,
        });

        const forwardedInvocation: ChatInvocation = {
            ...invocation,
            chatCtx,
        };

        if (toolFollowup) {
            // Tool follow-up should never expose tools to the model.
            delete forwardedInvocation.toolCtx;
            delete forwardedInvocation.toolChoice;
            delete forwardedInvocation.parallelToolCalls;
        }

        return this.innerLLM.chat(forwardedInvocation);
    }
}
