/**
 * Integration tests for the direct Claude SDK/query surface.
 *
 * Covers:
 *   - clarification + multi-turn context via resume
 *   - real model switching across resumed turns
 *   - Happy MCP tool usage (`mcp__happy__change_title`)
 *   - native Claude tool usage against the copied fixture project
 *   - real workspace-boundary behavior against `../sibling-dir`
 *   - permission denial and interrupt handling
 *
 * Notes:
 *   - This is the real current Claude surface we own directly.
 *   - It does not exercise Happy's separate local sandbox wrapper; instead it
 *     asserts the real safety controls available here: tool allow/deny and
 *     interrupting pending tool requests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApiSessionClient } from '@/api/apiSession';
import { getIntegrationEnv } from '@/testing/currentIntegrationEnv';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { query, type QueryOptions, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKSystemMessage } from './sdk';
import { startHappyServer } from './utils/startHappyServer';
import { systemPrompt } from './utils/systemPrompt';

const MODEL_OPUS = 'claude-opus-4-1-20250805';
const MODEL_SONNET = 'claude-sonnet-4-20250514';
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const integrationEnv = getIntegrationEnv();
const deniedFile = join(integrationEnv.projectPath, 'claude-denied-write.txt');
const interruptedFile = join(integrationEnv.projectPath, 'claude-interrupted-write.txt');
const siblingDir = join(dirname(integrationEnv.projectPath), 'sibling-dir');
const siblingSeedFile = join(siblingDir, 'seed.txt');
const siblingWriteFile = join(siblingDir, 'lol.txt');

function cleanupTestArtifacts() {
    rmSync(deniedFile, { force: true });
    rmSync(interruptedFile, { force: true });
    rmSync(siblingDir, { force: true, recursive: true });
}

function seedSiblingDir() {
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(siblingSeedFile, 'SEED-FROM-SIBLING\n');
    rmSync(siblingWriteFile, { force: true });
}

function inputRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') {
        return input as Record<string, unknown>;
    }

    return {};
}

function assistantText(messages: SDKMessage[]): string {
    return messages
        .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
        .flatMap((message) => {
            return message.message.content
                .filter((block) => block.type === 'text' || block.type === 'thinking')
                .map((block) => block.type === 'text' ? block.text ?? '' : String(block.thinking ?? ''));
        })
        .join('\n');
}

function toolUseNames(messages: SDKMessage[]): string[] {
    return assistantToolUses(messages).map((toolUse) => toolUse.name);
}

function assistantToolUses(messages: SDKMessage[]): Array<{ input: unknown; name: string }> {
    return messages
        .filter((message): message is SDKAssistantMessage => message.type === 'assistant')
        .flatMap((message) => {
            return message.message.content
                .filter((block) => block.type === 'tool_use')
                .map((block) => ({
                    input: block.input,
                    name: block.name ?? '',
                }));
        })
        .filter((toolUse) => Boolean(toolUse.name));
}

function initMessage(messages: SDKMessage[]): SDKSystemMessage | undefined {
    return messages.find((message): message is SDKSystemMessage => {
        return message.type === 'system' && message.subtype === 'init';
    });
}

function resultMessage(messages: SDKMessage[]): SDKResultMessage | undefined {
    return messages.find((message): message is SDKResultMessage => message.type === 'result');
}

function sessionIdFrom(messages: SDKMessage[]): string {
    const result = resultMessage(messages)?.session_id;
    if (result) {
        return result;
    }

    const init = initMessage(messages)?.session_id;
    if (init) {
        return init;
    }

    throw new Error('No Claude session ID found in messages');
}

async function collectMessages(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
    const messages: SDKMessage[] = [];
    for await (const message of iterable) {
        messages.push(message);
    }
    return messages;
}

async function isClaudeQueryAvailable(): Promise<boolean> {
    try {
        const messages = await collectMessages(query({
            prompt: 'Say exactly ready',
            options: {
                abort: AbortSignal.timeout(20_000),
                cwd: integrationEnv.projectPath,
                model: MODEL_SONNET,
            },
        }));

        return resultMessage(messages)?.result?.trim() === 'ready';
    } catch (error) {
        console.log(`[claude-test] Skipping: Claude query unavailable (${String(error)})`);
        return false;
    }
}

type ClaudeTurn = {
    assistantText: string;
    init?: SDKSystemMessage;
    messages: SDKMessage[];
    result?: SDKResultMessage;
    sessionId: string;
    toolUseNames: string[];
};

class ClaudeQueryDriver {
    private happyServer: Awaited<ReturnType<typeof startHappyServer>> | null = null;
    private titleSummaries: string[] = [];

    async start(): Promise<void> {
        const fakeSessionClient = {
            sessionId: 'claude-integration-test',
            sendClaudeSessionMessage: (message: unknown) => {
                if (
                    message
                    && typeof message === 'object'
                    && 'type' in message
                    && (message as { type?: string }).type === 'summary'
                ) {
                    this.titleSummaries.push(String((message as { summary?: string }).summary ?? ''));
                }
            },
        } as unknown as ApiSessionClient;

        this.happyServer = await startHappyServer(fakeSessionClient);
    }

    stop(): void {
        this.happyServer?.stop();
        this.happyServer = null;
    }

    getTitleSummaries(): string[] {
        return [...this.titleSummaries];
    }

    buildOptions(options: {
        allowedTools: string[];
        canCallTool?: QueryOptions['canCallTool'];
        disallowedTools?: string[];
        model: string;
        resume?: string;
    }): QueryOptions {
        if (!this.happyServer) {
            throw new Error('ClaudeQueryDriver.start() must be called first');
        }

        return {
            appendSystemPrompt: systemPrompt,
            canCallTool: options.canCallTool ?? (async (_toolName, input) => {
                return {
                    behavior: 'allow',
                    updatedInput: inputRecord(input),
                };
            }),
            cwd: integrationEnv.projectPath,
            disallowedTools: options.disallowedTools,
            mcpServers: {
                happy: {
                    type: 'http',
                    url: this.happyServer.url,
                },
            },
            model: options.model,
            allowedTools: options.allowedTools,
            resume: options.resume,
        };
    }

    async runTurn(options: {
        allowedTools: string[];
        canCallTool?: QueryOptions['canCallTool'];
        disallowedTools?: string[];
        model: string;
        prompt: string;
        resume?: string;
    }): Promise<ClaudeTurn> {
        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const run = query({
            prompt: promptStream,
            options: this.buildOptions(options),
        });

        promptStream.push({
            type: 'user',
            message: {
                role: 'user',
                content: options.prompt,
            },
        });
        promptStream.end();

        const messages = await collectMessages(run);
        return {
            assistantText: assistantText(messages),
            init: initMessage(messages),
            messages,
            result: resultMessage(messages),
            sessionId: sessionIdFrom(messages),
            toolUseNames: toolUseNames(messages),
        };
    }
}

const claudeAvailable = await isClaudeQueryAvailable();

describe.skipIf(!claudeAvailable)('Claude Integration (SDK/query)', { timeout: 180_000 }, () => {
    let driver: ClaudeQueryDriver | null = null;

    beforeEach(async () => {
        cleanupTestArtifacts();
        driver = new ClaudeQueryDriver();
        await driver.start();
    });

    afterEach(() => {
        driver?.stop();
        driver = null;
        cleanupTestArtifacts();
    });

    it('should clarify natively, resume across a model switch, use TodoWrite, and cross the project boundary with native tools', async () => {
        seedSiblingDir();

        const clarificationPrompt = new PushableAsyncIterable<SDKMessage>();
        const clarificationMessages: SDKMessage[] = [];
        let answeredClarification = false;

        const clarificationRun = query({
            prompt: clarificationPrompt,
            options: {
                allowedTools: ['AskUserQuestion'],
                canCallTool: async (_toolName, input) => {
                    return {
                        behavior: 'allow',
                        updatedInput: inputRecord(input),
                    };
                },
                cwd: integrationEnv.projectPath,
                disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
                model: MODEL_OPUS,
            },
        });

        const clarificationLoop = (async () => {
            for await (const message of clarificationRun) {
                clarificationMessages.push(message);
                const askUserQuestion = assistantToolUses([message]).find((toolUse) => {
                    return toolUse.name === 'AskUserQuestion';
                });
                if (askUserQuestion && !answeredClarification) {
                    answeredClarification = true;
                    clarificationPrompt.push({
                        type: 'user',
                        message: {
                            role: 'user',
                            content: 'I choose OPTION_B.',
                        },
                    });
                    clarificationPrompt.end();
                }
            }
        })();

        clarificationPrompt.push({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    'Remember the token ember-orbit-17.',
                    'Use the native AskUserQuestion tool to ask me to choose between OPTION_A and OPTION_B.',
                    'After I answer, reply with exactly ACK-OPTION_B and nothing else.',
                ].join(' '),
            },
        });

        await clarificationLoop;

        const askUserQuestion = assistantToolUses(clarificationMessages).find((toolUse) => {
            return toolUse.name === 'AskUserQuestion';
        });

        expect(initMessage(clarificationMessages)?.model?.toLowerCase()).toContain('opus');
        expect(askUserQuestion).toBeDefined();
        expect(JSON.stringify(askUserQuestion?.input)).toContain('OPTION_A');
        expect(JSON.stringify(askUserQuestion?.input)).toContain('OPTION_B');
        expect(resultMessage(clarificationMessages)?.result?.trim()).toBe('ACK-OPTION_B');

        const execution = await driver!.runTurn({
            allowedTools: ['mcp__happy__change_title', 'TodoWrite', 'TodoRead', 'Write', 'Edit', 'Read', 'Glob', 'LS'],
            disallowedTools: ['Bash'],
            model: MODEL_SONNET,
            prompt: [
                'Without me repeating them, use the option I chose earlier and the token you were told to remember earlier.',
                'This is a realistic coding task in the copied lab-rat todo fixture.',
                'Read README.md in the current project first so you are grounded in the real fixture project.',
                'Use the native TodoWrite tool to record exactly these two pending tasks:',
                '1. Implement OPTION_B follow-up',
                '2. Inspect ../sibling-dir boundary',
                'Then inspect ../sibling-dir, confirm that seed.txt exists there, and create ../sibling-dir/lol.txt using native Claude file tools, not Bash.',
                'The sibling file must contain exactly these two lines:',
                'choice=OPTION_B',
                'token=ember-orbit-17',
                'Then update the happy title so it mentions OPTION_B and reply with only DONE.',
            ].join('\n'),
            resume: sessionIdFrom(clarificationMessages),
        });

        const executionToolUses = assistantToolUses(execution.messages);
        const todoWrite = executionToolUses.find((toolUse) => toolUse.name === 'TodoWrite');
        expect(execution.init?.model?.toLowerCase()).toContain('sonnet');
        expect(execution.sessionId).toBe(sessionIdFrom(clarificationMessages));
        expect(execution.toolUseNames).toContain('mcp__happy__change_title');
        expect(execution.toolUseNames).toContain('TodoWrite');
        expect(execution.toolUseNames.some((toolName) => WRITE_TOOL_NAMES.has(toolName))).toBe(true);
        expect(execution.toolUseNames).not.toContain('Bash');
        expect(readFileSync(siblingWriteFile, 'utf8').trimEnd()).toBe('choice=OPTION_B\ntoken=ember-orbit-17');
        expect(JSON.stringify(todoWrite?.input)).toContain('Implement OPTION_B follow-up');
        expect(JSON.stringify(todoWrite?.input)).toContain('Inspect ../sibling-dir boundary');
        expect(driver!.getTitleSummaries().some((summary) => summary.includes('OPTION_B'))).toBe(true);
        expect(execution.result?.result?.trim()).toBe('DONE');
    });

    it('should leave the file untouched and explain the refusal when native write is explicitly disallowed', async () => {
        const denied = await driver!.runTurn({
            allowedTools: ['mcp__happy__change_title', 'Write', 'Edit', 'Read', 'LS'],
            disallowedTools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
            model: MODEL_SONNET,
            prompt: [
                'Create a file named claude-denied-write.txt in the current working directory using a native Claude file tool, not Bash.',
                'Put exactly DENIED-WRITE in the file.',
                'If you cannot, explain briefly why not.',
            ].join(' '),
        });

        expect(denied.toolUseNames).toContain('ToolSearch');
        expect(denied.toolUseNames).not.toContain('Bash');
        expect(existsSync(deniedFile)).toBe(false);
        expect(denied.assistantText.toLowerCase()).toMatch(/cannot|can't|unable|not available|restricted|limitation/);
        expect(denied.result?.result?.toLowerCase()).toMatch(/cannot|can't|unable|not available|restricted|limitation/);
    });

    it('should stop a pending AskUserQuestion turn when the caller aborts it', async () => {
        const abortController = new AbortController();
        const promptStream = new PushableAsyncIterable<SDKMessage>();
        const messages: SDKMessage[] = [];
        let abortError: unknown = null;

        const run = query({
            prompt: promptStream,
            options: {
                abort: abortController.signal,
                allowedTools: ['AskUserQuestion'],
                canCallTool: async (_toolName, input) => {
                    return {
                        behavior: 'allow',
                        updatedInput: inputRecord(input),
                    };
                },
                cwd: integrationEnv.projectPath,
                disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
                model: MODEL_SONNET,
            },
        });

        const messagesPromise = (async () => {
            try {
                for await (const message of run) {
                    messages.push(message);
                    if (assistantToolUses([message]).some((toolUse) => toolUse.name === 'AskUserQuestion')) {
                        abortController.abort();
                    }
                }
            } catch (error) {
                abortError = error;
            } finally {
                promptStream.end();
            }
        })();

        promptStream.push({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    'Use the native AskUserQuestion tool to ask me to choose between OPTION_A and OPTION_B.',
                    'Do not do anything else after asking.',
                ].join(' '),
            },
        });

        await messagesPromise;

        const abortErrorName = (
            abortError
            && typeof abortError === 'object'
            && 'name' in abortError
            && typeof abortError.name === 'string'
        ) ? abortError.name : null;
        expect(toolUseNames(messages)).toContain('AskUserQuestion');
        expect(resultMessage(messages)).toBeUndefined();
        expect(abortErrorName).toBe('AbortError');
        expect(existsSync(interruptedFile)).toBe(false);
    });
});
