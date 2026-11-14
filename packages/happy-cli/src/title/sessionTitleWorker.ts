import { ApiSessionClient } from '@/api/apiSession';
import { query, type SDKMessage, type SDKResultMessage } from '@/claude/sdk';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { ReasoningEffort } from '@/codex/codexAppServerTypes';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';

export type TitleWorkerProvider = 'ask' | 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw' | 'acp';

export interface RegenerateSessionTitleRequest {
    transcript: string;
    currentTitle?: string | null;
    projectPath?: string | null;
    model?: string | null;
    effort?: string | null;
}

export type RegenerateSessionTitleResponse =
    | { success: true; title: string }
    | { success: false; message: string };

const TITLE_TIMEOUT_MS = 60_000;
const MAX_TITLE_LENGTH = 80;

function supportsTitleRegeneration(provider: TitleWorkerProvider): boolean {
    return provider === 'claude' || provider === 'codex';
}

export function buildSessionTitlePrompt(request: RegenerateSessionTitleRequest): string {
    const currentTitleLine = request.currentTitle?.trim()
        ? `Current title: ${request.currentTitle.trim()}`
        : 'Current title: none';
    const projectPathLine = request.projectPath?.trim()
        ? `Project path: ${request.projectPath.trim()}`
        : 'Project path: unknown';

    return trimIdent(`
        Generate a concise chat session title from the transcript below.

        Rules:
        - Output only the title.
        - Do not use markdown, quotes, JSON, explanations, or trailing punctuation.
        - Prefer the language used by the user in the transcript.
        - Capture the actual current task, not just the first greeting.
        - Keep it under 80 characters.

        ${currentTitleLine}
        ${projectPathLine}

        Transcript:
        ${request.transcript}
    `);
}

export function sanitizeGeneratedTitle(rawTitle: string): string {
    const trimmed = rawTitle.trim();
    if (!trimmed) {
        return '';
    }

    let text = trimmed;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown };
            if (typeof parsed.title === 'string') {
                text = parsed.title;
            }
        } catch {
            // Fall through to plain text cleanup.
        }
    }

    text = text
        .replace(/^```(?:json|text)?/i, '')
        .replace(/```$/i, '')
        .trim()
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) ?? '';

    text = text
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[。.!！?？]+$/g, '')
        .trim();

    if (text.length > MAX_TITLE_LENGTH) {
        return text.slice(0, MAX_TITLE_LENGTH).trim();
    }
    return text;
}

function assistantText(messages: SDKMessage[]): string {
    const chunks: string[] = [];
    for (const message of messages) {
        if (message.type !== 'assistant') {
            continue;
        }
        for (const content of message.message.content) {
            if (content.type === 'text') {
                chunks.push(content.text);
            }
        }
    }
    return chunks.join('\n').trim();
}

function resultText(messages: SDKMessage[]): string | undefined {
    const result = messages.find((message): message is SDKResultMessage => message.type === 'result');
    return result && 'result' in result ? result.result : undefined;
}

async function generateClaudeSessionTitle(request: RegenerateSessionTitleRequest): Promise<string> {
    const messages: SDKMessage[] = [];
    for await (const message of query({
        prompt: buildSessionTitlePrompt(request),
        options: {
            abort: AbortSignal.timeout(TITLE_TIMEOUT_MS),
            allowedTools: [],
            cwd: request.projectPath ?? undefined,
            maxTurns: 1,
            model: request.model ?? undefined,
            permissionMode: 'default',
        },
    })) {
        messages.push(message);
    }

    const title = sanitizeGeneratedTitle(resultText(messages) ?? assistantText(messages));
    if (!title) {
        throw new Error('Title worker returned an empty title');
    }
    return title;
}

async function generateCodexSessionTitle(request: RegenerateSessionTitleRequest): Promise<string> {
    const client = new CodexAppServerClient();
    let output = '';

    client.setEventHandler((message) => {
        if (message.type === 'agent_message' && typeof message.message === 'string') {
            output += message.message;
        }
    });
    client.setApprovalHandler(async () => 'denied');

    try {
        await client.connect();
        await client.startThread({
            cwd: request.projectPath ?? process.cwd(),
            model: request.model ?? undefined,
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
        const result = await client.sendTurnAndWait(buildSessionTitlePrompt(request), {
            cwd: request.projectPath ?? process.cwd(),
            model: request.model ?? undefined,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            effort: isReasoningEffort(request.effort) ? request.effort : undefined,
            turnTimeoutMs: TITLE_TIMEOUT_MS,
        });
        if (result.aborted) {
            throw new Error('Title worker was aborted');
        }

        const title = sanitizeGeneratedTitle(output);
        if (!title) {
            throw new Error('Title worker returned an empty title');
        }
        return title;
    } finally {
        await client.disconnect();
    }
}

function isReasoningEffort(value: string | null | undefined): value is ReasoningEffort {
    return value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

async function generateSessionTitle(
    provider: TitleWorkerProvider,
    request: RegenerateSessionTitleRequest,
): Promise<string> {
    if (provider === 'claude') {
        return generateClaudeSessionTitle(request);
    }
    if (provider === 'codex') {
        return generateCodexSessionTitle(request);
    }
    throw new Error(`Title regeneration is not supported for ${provider} sessions yet`);
}

export function registerSessionTitleWorker(
    session: ApiSessionClient,
    provider: TitleWorkerProvider,
) {
    if (supportsTitleRegeneration(provider)) {
        session.updateMetadata((metadata) => ({
            ...metadata,
            capabilities: {
                ...metadata.capabilities,
                regenerateTitle: true,
            },
        }));
    }

    session.rpcHandlerManager.registerHandler<RegenerateSessionTitleRequest, RegenerateSessionTitleResponse>(
        'regenerateTitle',
        async (request) => {
            const transcript = request.transcript.trim();
            if (!transcript) {
                return { success: false, message: 'No transcript was provided for title regeneration.' };
            }

            try {
                const title = await generateSessionTitle(provider, {
                    ...request,
                    transcript,
                });
                await session.updateMetadataAndAwait((metadata) => ({
                    ...metadata,
                    summary: {
                        text: title,
                        updatedAt: Date.now(),
                    },
                }));
                return { success: true, title };
            } catch (error) {
                logger.debug('[title-worker] Failed to regenerate title:', error);
                return {
                    success: false,
                    message: error instanceof Error ? error.message : 'Failed to regenerate title',
                };
            }
        },
    );
}
