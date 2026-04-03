#!/usr/bin/env npx tsx

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SyncNode } from '../sync-node';
import type { MessageWithParts, Part, SessionID } from '../v3-compat';
import {
    bootTestInfrastructure,
    createIsolatedProjectCopy,
    getAuthToken,
    getDaemonHttpPort,
    getEncryptionSecret,
    getServerUrl,
    spawnSessionViaDaemon,
    teardownTestInfrastructure,
} from './setup';
import {
    getAssistantMessages,
    getFullText,
    getTextParts,
    getToolParts,
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    resolveSessionKeyMaterial,
    waitForCondition,
    waitForPendingQuestion,
} from './helpers';
import {
    DEFAULT_CAPTURE_HOLD_MS,
    DEFAULT_FINAL_CAPTURE_MS,
    DEFAULT_INITIAL_RECORDING_DELAY_MS,
    DEFAULT_INTER_STEP_DELAY_MS,
    UX_REVIEW_OUTPUT_DIR,
    WALKTHROUGH_REDIRECT_PORT,
    filterWalkthroughSteps,
    parseStepBoundary,
    stepFileBase,
    WALKTHROUGH_STEPS,
    type WalkthroughStep,
} from './walkthrough-flow';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUTPUT_DIR = process.env.HAPPY_WALKTHROUGH_OUTPUT_DIR
    ? resolvePath(REPO_ROOT, process.env.HAPPY_WALKTHROUGH_OUTPUT_DIR)
    : join(REPO_ROOT, UX_REVIEW_OUTPUT_DIR);
const SESSION_URL_FILE = join(OUTPUT_DIR, 'session-url.txt');
const DONE_MARKER_FILE = join(OUTPUT_DIR, 'walkthrough-driver.done');
const INFO_FILE = join(OUTPUT_DIR, 'walkthrough-driver-state.json');
const RESULTS_FILE = join(OUTPUT_DIR, 'walkthrough-driver-results.json');
const DRIVER_LOG_FILE = join(OUTPUT_DIR, 'walkthrough-driver.log');
const WEB_PORT = Number.parseInt(process.env.HAPPY_WALKTHROUGH_WEB_PORT ?? '19019', 10);
const SERVER_PORT = process.env.HAPPY_TEST_SERVER_PORT ?? '34193';
const REDIRECT_PORT = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_REDIRECT_PORT ?? `${WALKTHROUGH_REDIRECT_PORT}`,
    10,
);
const INITIAL_RECORDING_DELAY_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_INITIAL_DELAY_MS ?? `${DEFAULT_INITIAL_RECORDING_DELAY_MS}`,
    10,
);
const INTER_STEP_DELAY_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_INTER_STEP_DELAY_MS ?? `${DEFAULT_INTER_STEP_DELAY_MS}`,
    10,
);
const CAPTURE_HOLD_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_CAPTURE_HOLD_MS ?? `${DEFAULT_CAPTURE_HOLD_MS}`,
    10,
);
const POST_DONE_HOLD_MS = Number.parseInt(
    process.env.HAPPY_WALKTHROUGH_POST_DONE_HOLD_MS ?? `${DEFAULT_FINAL_CAPTURE_MS}`,
    10,
);

const CLAUDE_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
const CLAUDE_HAIKU_MODEL = { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' };

interface StepResult {
    stepId: number;
    name: string;
    status: 'pass' | 'fail';
    durationMs: number;
    sessionId: string;
    tools: Array<{ tool: string; status: string }>;
    textSnippet: string;
    continuityWarning: boolean;
    error: string | null;
    artifactBase: string;
}

interface WalkthroughStatePayload {
    status: string;
    label: string;
    currentStep: { id: number; name: string } | null;
}

function log(message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${message}`;
    console.log(line);
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectToolParts(messages: MessageWithParts[], afterIndex: number): Array<{ tool: string; status: string }> {
    return messages
        .slice(afterIndex)
        .flatMap(getToolParts)
        .map((part) => ({
            tool: part.tool,
            status: part.state.status,
        }));
}

function collectTextSnippet(messages: MessageWithParts[], afterIndex: number): string {
    return messages
        .slice(afterIndex)
        .flatMap(getTextParts)
        .map((part) => part.text)
        .join(' ')
        .slice(0, 800);
}

function hasTerminalStepFinish(message: MessageWithParts): boolean {
    return message.parts.some(
        (part) => part.type === 'step-finish' && part.reason !== 'tool-calls',
    );
}

function isTerminalToolStatus(status: string): boolean {
    return status === 'completed' || status === 'error';
}

function assistantTurnSignature(messages: MessageWithParts[]): string {
    return messages.map((message) => message.parts.map((part) => {
        switch (part.type) {
            case 'tool':
                return `tool:${part.tool}:${part.callID}:${part.state.status}`;
            case 'step-finish':
                return `step-finish:${part.reason}`;
            case 'text':
                return `text:${part.text.slice(0, 120)}`;
            case 'reasoning':
                return `reasoning:${part.text.slice(0, 80)}`;
            default:
                return part.type;
        }
    }).join('|')).join('||');
}

function hasTextContent(messages: MessageWithParts[]): boolean {
    return messages.some((message) => getTextParts(message).length > 0);
}

function assistantMessagesSince(node: SyncNode, sessionId: SessionID, afterCount: number): MessageWithParts[] {
    return getAssistantMessages(node, sessionId).slice(afterCount);
}

function assistantToolsSince(
    node: SyncNode,
    sessionId: SessionID,
    afterCount: number,
): Array<Part & { type: 'tool' }> {
    return assistantMessagesSince(node, sessionId, afterCount).flatMap(getToolParts);
}

function latestToolStates(messages: MessageWithParts[]): Array<Part & { type: 'tool' }> {
    const latest = new Map<string, Part & { type: 'tool' }>();
    let anonymousIndex = 0;

    for (const tool of messages.flatMap(getToolParts)) {
        const key = tool.callID
            ? `${tool.tool}:${tool.callID}`
            : `${tool.tool}:anonymous:${anonymousIndex++}`;
        latest.set(key, tool);
    }

    return Array.from(latest.values());
}

function toolText(tool: Part & { type: 'tool' }): string {
    const state = tool.state as Record<string, unknown>;
    return [
        tool.tool,
        JSON.stringify(state.input ?? {}),
        typeof state.title === 'string' ? state.title : '',
        typeof state.output === 'string' ? state.output : '',
        typeof state.error === 'string' ? state.error : '',
        JSON.stringify(state.metadata ?? {}),
    ].join(' ').toLowerCase();
}

function startWebAppServer(serverUrl: string): ChildProcess {
    const child = spawn('yarn', ['workspace', 'happy-app', 'web:test', '--port', String(WEB_PORT)], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            BROWSER: 'none',
            CI: '1',
            NODE_ENV: 'development',
            EXPO_PUBLIC_HAPPY_SERVER_URL: serverUrl,
            EXPO_PUBLIC_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
            DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
    return child;
}

async function waitForWebReady(timeoutMs = 300000): Promise<void> {
    const url = `http://127.0.0.1:${WEB_PORT}`;
    const start = Date.now();
    let lastHtml = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            const body = await response.text();
            lastHtml = body;
            if (response.ok && body.includes('Happy')) {
                const bundlePath = body.match(/<script[^>]+src="([^"]+\.bundle[^"]*)"[^>]*><\/script>/i)?.[1];
                if (!bundlePath) {
                    await sleep(500);
                    continue;
                }
                const bundleUrl = new URL(bundlePath, url).toString();
                const bundleResponse = await fetch(bundleUrl, { signal: AbortSignal.timeout(120000) });
                if (bundleResponse.ok) {
                    bundleResponse.body?.cancel().catch(() => {});
                    return;
                }
            }
        } catch {}
        await sleep(1000);
    }
    throw new Error(`Web app not ready at ${url}. Last HTML: ${lastHtml.slice(0, 500)}`);
}

async function waitForConditionApprovingAll(
    node: SyncNode,
    predicate: () => boolean,
    timeoutMs: number,
    opts: { autoAnswerQuestions?: boolean } = {},
): Promise<void> {
    const approvedIds = new Set<string>();
    const answeredIds = new Set<string>();
    await waitForCondition(() => {
        for (const session of node.state.sessions.values()) {
            for (const permission of session.permissions) {
                if (!permission.resolved && !approvedIds.has(permission.permissionId)) {
                    approvedIds.add(permission.permissionId);
                    node.approvePermission(session.info.id, permission.permissionId, { decision: 'once' }).catch(() => {});
                }
            }
            if (opts.autoAnswerQuestions) {
                for (const question of session.questions) {
                    if (!question.resolved && !answeredIds.has(question.questionId)) {
                        answeredIds.add(question.questionId);
                        node.answerQuestion(session.info.id, question.questionId, [['Vitest']]).catch(() => {});
                    }
                }
            }
        }
        return predicate();
    }, timeoutMs);
}

async function waitForStepFinishApprovingAll(
    node: SyncNode,
    sessionId: SessionID,
    afterCount: number,
    timeoutMs: number,
    opts: { autoAnswerQuestions?: boolean } = {},
): Promise<void> {
    let lastLogAt = 0;
    let lastAssistantSignature = '';
    let stableSince = Date.now();
    await waitForConditionApprovingAll(
        node,
        () => {
            const assistant = assistantMessagesSince(node, sessionId, afterCount);
            if (assistant.length === 0) {
                const now = Date.now();
                if (now - lastLogAt > 15000) {
                    lastLogAt = now;
                    const session = node.state.sessions.get(sessionId as string);
                    const totalMsgs = getAssistantMessages(node, sessionId).length;
                    log(`  wait: no new messages (afterCount=${afterCount}, total=${totalMsgs}, session=${session?.status.type ?? 'missing'})`);
                }
                return false;
            }

            const signature = assistantTurnSignature(assistant);
            if (signature !== lastAssistantSignature) {
                lastAssistantSignature = signature;
                stableSince = Date.now();
            }

            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                for (const [offset, message] of assistant.entries()) {
                    const partTypes = message.parts.map((part) => {
                        if (part.type === 'step-finish') {
                            return `step-finish(reason=${part.reason})`;
                        }
                        if (part.type === 'tool') {
                            return `tool(${part.tool},status=${part.state.status})`;
                        }
                        if (part.type === 'text') {
                            return `text(${part.text.slice(0, 40)}...)`;
                        }
                        if (part.type === 'reasoning') {
                            return `reasoning(${part.text.slice(0, 40)}...)`;
                        }
                        return part.type;
                    });
                    log(`  wait msg[${afterCount + offset}] (${message.parts.length} parts): ${partTypes.join(', ')}`);
                }
            }

            const session = node.state.sessions.get(sessionId as string);
            if (!session) {
                return false;
            }

            const tools = latestToolStates(assistant);
            const lastMessage = assistant.at(-1);
            const lastMessageTools = lastMessage ? latestToolStates([lastMessage]) : [];
            const allToolsTerminal = tools.every((tool) => isTerminalToolStatus(tool.state.status));
            const lastMessageToolsTerminal = lastMessageTools.every((tool) => isTerminalToolStatus(tool.state.status));
            const noPendingPrompts = !session.permissions.some((permission) => !permission.resolved)
                && !session.questions.some((question) => !question.resolved);
            const sessionSettled = session.status.type === 'idle'
                || session.status.type === 'completed'
                || session.status.type === 'error';
            const stableForMs = Date.now() - stableSince;
            const hasText = hasTextContent(assistant);
            const hasTerminalFinish = assistant.some(hasTerminalStepFinish);
            const settledTurn = sessionSettled
                && noPendingPrompts
                && allToolsTerminal
                && hasTerminalFinish
                && stableForMs >= 5000;
            const quietTextTurn = noPendingPrompts
                && allToolsTerminal
                && hasText
                && stableForMs >= 8000;
            const stableToolOnlyTurn = noPendingPrompts
                && allToolsTerminal
                && lastMessageToolsTerminal
                && tools.length > 0
                && !hasText
                && stableForMs >= 15000;
            // Fallback: some Claude turns (subagents/background work) leave stale
            // tool/session status behind even after the final text turn is stable.
            const stableTerminalTextTurn = noPendingPrompts
                && hasTerminalFinish
                && hasText
                && stableForMs >= 15000;
            return settledTurn || quietTextTurn || stableToolOnlyTurn || stableTerminalTextTurn;
        },
        timeoutMs,
        opts,
    );
}

async function waitForPendingPermissionInAnySession(
    node: SyncNode,
    timeoutMs: number,
): Promise<{ sessionId: SessionID; permission: { permissionId: string; block: { permission?: string } } }> {
    await waitForCondition(() => {
        return Array.from(node.state.sessions.values()).some((session) =>
            session.permissions.some((permission) => !permission.resolved),
        );
    }, timeoutMs);

    for (const session of node.state.sessions.values()) {
        const permission = session.permissions.find((item) => !item.resolved);
        if (permission) {
            return {
                sessionId: session.info.id,
                permission: permission as { permissionId: string; block: { permission?: string } },
            };
        }
    }
    throw new Error('Permission appeared and disappeared before it could be captured');
}

async function holdForCapture(reason: string, ms = CAPTURE_HOLD_MS, _screenshotName?: string): Promise<void> {
    if (ms <= 0) {
        return;
    }
    log(`  Holding ${Math.round(ms / 1000)}s for ${reason}...`);
    await sleep(ms);
}

async function waitForTerminalStepFinish(
    node: SyncNode,
    sessionId: SessionID,
    afterCount: number,
    timeoutMs: number,
): Promise<void> {
    await waitForCondition(() => {
        return assistantMessagesSince(node, sessionId, afterCount).some(hasTerminalStepFinish);
    }, timeoutMs);
}

async function waitForSessionStop(
    node: SyncNode,
    sessionId: SessionID,
    timeoutMs: number,
): Promise<void> {
    await waitForCondition(() => {
        const session = node.state.sessions.get(sessionId as string);
        if (!session) {
            return false;
        }
        return session.status.type === 'completed' || session.status.type === 'error';
    }, timeoutMs);
}

async function approvePermissionsIndividuallyUntilSettled(
    node: SyncNode,
    sessionId: SessionID,
    afterCount: number,
    timeoutMs: number,
): Promise<void> {
    const approvedIds = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    let heldCapture = false;

    while (Date.now() < deadline) {
        const pending = Array.from(node.state.sessions.values()).flatMap((session) => (
            session.permissions
                .filter((permission) => !permission.resolved && !approvedIds.has(permission.permissionId))
                .map((permission) => ({
                    sessionId: session.info.id,
                    permission,
                }))
        ));

        if (pending.length > 0) {
            if (!heldCapture) {
                heldCapture = true;
                await holdForCapture('multiple permission prompts', CAPTURE_HOLD_MS, 'component-multiple-permissions');
            }
            const next = pending[0];
            approvedIds.add(next.permission.permissionId);
            await node.approvePermission(next.sessionId, next.permission.permissionId, { decision: 'once' }).catch(() => {});
            await sleep(750);
        }

        if (assistantMessagesSince(node, sessionId, afterCount).some(hasTerminalStepFinish)) {
            return;
        }

        await sleep(500);
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for multi-permission step to settle`);
}

function isContinuityWarningText(text: string): boolean {
    return /don't have (any )?context|no context from the previous session|start from scratch/i.test(text);
}

async function main(): Promise<void> {
    const startStepId = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_START_STEP);
    const endStepId = parseStepBoundary(process.env.HAPPY_WALKTHROUGH_END_STEP);
    const activeSteps = filterWalkthroughSteps(WALKTHROUGH_STEPS, startStepId, endStepId);

    await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(OUTPUT_DIR, { recursive: true });
    process.env.HAPPY_TEST_SERVER_PORT = SERVER_PORT;

    let webProcess: ChildProcess | null = null;
    let node!: SyncNode;
    let redirectServer: Server | null = null;
    const results: StepResult[] = [];

    try {
        log(`Booting isolated server + daemon on port ${SERVER_PORT}...`);
        await bootTestInfrastructure();
        const projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const appJsPath = resolvePath(projectDir, 'app.js');

        webProcess = startWebAppServer(getServerUrl());
        log('Waiting for Expo web...');
        await waitForWebReady();

        node = new SyncNode(
            getServerUrl(),
            makeAccountToken(),
            makeKeyMaterial(),
            { resolveSessionKeyMaterial },
        );
        await node.connect();

        const makeSessionUrl = (sessionId: string) => {
            const secret64url = encodeBase64Url(getEncryptionSecret());
            const stateUrl = `http://127.0.0.1:${REDIRECT_PORT}/state`;
            return `http://127.0.0.1:${WEB_PORT}/session/${sessionId}?dev_token=${encodeURIComponent(getAuthToken())}&dev_secret=${encodeURIComponent(secret64url)}&walkthrough_state_url=${encodeURIComponent(stateUrl)}`;
        };

        let currentWalkthroughState: WalkthroughStatePayload = {
            status: 'booting',
            label: 'Walkthrough Booting',
            currentStep: null,
        };

        // Redirect server: webreel navigates here after session changes
        let currentRedirectUrl = '';
        redirectServer = createServer((req, res) => {
            if (req.url?.startsWith('/state')) {
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(JSON.stringify(currentWalkthroughState));
                return;
            }
            if (currentRedirectUrl) {
                res.writeHead(302, { Location: currentRedirectUrl });
            } else {
                res.writeHead(503);
            }
            res.end();
        });
        await new Promise<void>((resolve) => redirectServer!.listen(REDIRECT_PORT, '127.0.0.1', resolve));
        log(`Redirect server on http://127.0.0.1:${REDIRECT_PORT}`);

        log('Spawning initial Claude session via daemon...');
        let currentSessionId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' }) as SessionID;
        await waitForCondition(() => node!.state.sessions.has(currentSessionId as string), 30000);
        let resumeSourceSessionId: SessionID | null = null;
        const allSessionIds: string[] = [currentSessionId as string];
        currentRedirectUrl = makeSessionUrl(currentSessionId as string);

        const writeSessionUrl = async (): Promise<void> => {
            const url = makeSessionUrl(currentSessionId as string);
            currentRedirectUrl = url;
            await writeFile(SESSION_URL_FILE, `${url}\n`);
        };

        const writeInfo = async (status: string, currentStep?: WalkthroughStep): Promise<void> => {
            currentWalkthroughState = {
                status,
                label: status === 'completed'
                    ? 'Walkthrough Completed'
                    : status === 'step_failed' && currentStep
                        ? `Walkthrough Failed Step ${currentStep.id}: ${currentStep.name}`
                        : currentStep
                            ? `Walkthrough Step ${currentStep.id}: ${currentStep.name}`
                            : 'Walkthrough Booted',
                currentStep: currentStep ? { id: currentStep.id, name: currentStep.name } : null,
            };
            await writeFile(INFO_FILE, JSON.stringify({
                status,
                walkthroughState: currentWalkthroughState,
                serverUrl: getServerUrl(),
                webUrl: `http://127.0.0.1:${WEB_PORT}`,
                daemonPort: getDaemonHttpPort(),
                projectDir,
                currentSessionId,
                currentSessionUrl: makeSessionUrl(currentSessionId as string),
                resumeSourceSessionId,
                allSessionUrls: allSessionIds.map((id) => ({ sessionId: id, url: makeSessionUrl(id) })),
                currentStep: currentStep ? { id: currentStep.id, name: currentStep.name } : null,
                resultsFile: RESULTS_FILE,
                sessionUrlFile: SESSION_URL_FILE,
                doneMarkerFile: DONE_MARKER_FILE,
                logFile: DRIVER_LOG_FILE,
                startStepId,
                endStepId,
                initialRecordingDelayMs: INITIAL_RECORDING_DELAY_MS,
                interStepDelayMs: INTER_STEP_DELAY_MS,
                captureHoldMs: CAPTURE_HOLD_MS,
                postDoneHoldMs: POST_DONE_HOLD_MS,
            }, null, 2));
        };

        await writeSessionUrl();
        await writeInfo('booted');
        await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));

        const step0 = activeSteps.find((step) => step.id === 0);
        if (step0) {
            results.push({
                stepId: step0.id,
                name: step0.name,
                status: 'pass',
                durationMs: 0,
                sessionId: currentSessionId as string,
                tools: [],
                textSnippet: '',
                continuityWarning: false,
                error: null,
                artifactBase: stepFileBase(step0),
            });
            await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
            await writeInfo('running', step0);
        }

        if (activeSteps.some((step) => step.id !== 0)) {
            log(`Session URL written to ${SESSION_URL_FILE}`);
            log('Ready for webreel capture.');
            if (INITIAL_RECORDING_DELAY_MS > 0) {
                log(`Waiting ${Math.round(INITIAL_RECORDING_DELAY_MS / 1000)}s for recorder attach...`);
                await sleep(INITIAL_RECORDING_DELAY_MS);
            }
        }

        for (const step of activeSteps.filter((item) => item.id !== 0)) {
            const startedAt = Date.now();
            let error: string | null = null;
            const beforeAssistant = getAssistantMessages(node, currentSessionId).length;
            let artifactAfterCount = beforeAssistant;

            log(`Step ${step.id} — ${step.name}`);
            await writeInfo('running', step);

            try {
                const sendPrompt = async (
                    prompt: string,
                    msgId: string,
                    model = CLAUDE_MODEL,
                ) => {
                    await node!.sendMessage(
                        currentSessionId,
                        makeUserMessage(msgId, currentSessionId, prompt, 'claude', model),
                    );
                };

                if (step.action === 'cancel') {
                    if (!step.prompt) {
                        throw new Error(`Step ${step.id} is missing a prompt`);
                    }
                    resumeSourceSessionId = currentSessionId;
                    await sendPrompt(step.prompt, `step${step.id}`);
                    try {
                        await waitForCondition(
                            () => getAssistantMessages(node!, currentSessionId).length > beforeAssistant,
                            15000,
                        );
                    } catch {
                        log('  Cancel step: Claude did not start responding in 15s, stopping anyway.');
                    }
                    await holdForCapture('mid-stream cancellation');
                    await node.stopSession(currentSessionId);
                    await waitForSessionStop(node, currentSessionId, 30000);
                } else if (step.action === 'stop') {
                    resumeSourceSessionId = currentSessionId;
                    await holdForCapture('session close');
                    await node.stopSession(currentSessionId);
                    await waitForSessionStop(node, currentSessionId, 30000);
                } else if (step.action === 'resume') {
                    if (!resumeSourceSessionId) {
                        throw new Error(`No stopped session available to resume for step ${step.id}`);
                    }
                    await waitForSessionStop(node, resumeSourceSessionId, 30000).catch(() => {
                        log(`  Resume source session ${resumeSourceSessionId} did not report completed before resume.`);
                    });
                    currentSessionId = await spawnSessionViaDaemon({
                        directory: projectDir,
                        agent: 'claude',
                        sessionId: resumeSourceSessionId,
                    }) as SessionID;
                    await waitForCondition(() => node!.state.sessions.has(currentSessionId as string), 30000);
                    allSessionIds.push(currentSessionId as string);
                    await writeSessionUrl();

                    if (step.prompt) {
                        const resumedBefore = getAssistantMessages(node, currentSessionId).length;
                        artifactAfterCount = resumedBefore;
                        await sendPrompt(step.prompt, `step${step.id}`);
                        await waitForStepFinishApprovingAll(node, currentSessionId, resumedBefore, step.timeoutMs);
                    } else {
                        artifactAfterCount = 0;
                    }
                    resumeSourceSessionId = null;
                } else if (step.id === 3) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 30000);
                        await holdForCapture('permission prompt before denial', CAPTURE_HOLD_MS, 'component-permission-prompt-denied');
                        await node.denyPermission(pending.sessionId, pending.permission.permissionId, {
                            reason: 'No — show me the diff first.',
                        });
                        await waitForCondition(() => {
                            return assistantToolsSince(node, currentSessionId, beforeAssistant).some((tool) =>
                                tool.tool === 'Edit' && tool.state.status === 'error',
                            );
                        }, 30000).catch(() => {});

                        const followupAfterCount = getAssistantMessages(node, currentSessionId).length;
                        artifactAfterCount = followupAfterCount;
                        await sendPrompt('No — show me the diff first.', 'step3-followup');
                        await waitForConditionApprovingAll(node, () => {
                            return assistantMessagesSince(node, currentSessionId, followupAfterCount).some((message) => {
                                if (!hasTerminalStepFinish(message)) {
                                    return false;
                                }
                                const fullText = getFullText(message);
                                return /```diff|--- a\/|\+\+\+ b\//.test(fullText);
                            });
                        }, step.timeoutMs);
                    } catch {
                        log('  No permission prompt appeared for Step 3; accepting text-only recovery path.');
                        artifactAfterCount = beforeAssistant;
                        await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    }
                } else if (step.id === 4) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 30000);
                        await holdForCapture('permission prompt before single approval', CAPTURE_HOLD_MS, 'component-permission-prompt-approve-once');
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, { decision: 'once' });
                    } catch {
                        log('  No permission prompt appeared for Step 4; waiting for Claude response.');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 5) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 30000);
                        await holdForCapture('permission prompt before allow-always approval', CAPTURE_HOLD_MS, 'component-permission-prompt-approve-always');
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, {
                            decision: 'always',
                            allowTools: pending.permission.block.permission ? [pending.permission.block.permission] : undefined,
                        });
                    } catch {
                        log('  No permission prompt appeared for Step 5; waiting for Claude response.');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 12) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        await waitForPendingQuestion(node, currentSessionId, 60000);
                        await holdForCapture('question prompt', CAPTURE_HOLD_MS, 'component-question-prompt');
                    } catch {
                        await waitForConditionApprovingAll(
                            node,
                            () => assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) => {
                                const text = getFullText(message).toLowerCase();
                                return hasTerminalStepFinish(message)
                                    && (
                                        text.includes('which one')
                                        || text.includes('which framework')
                                        || text.includes('what framework')
                                        || text.includes('vitest')
                                        || text.includes('jest')
                                    );
                            }),
                            60000,
                        );
                        await holdForCapture('text-based question prompt');
                    }
                } else if (step.id === 13) {
                    const question = node.state.sessions.get(currentSessionId as string)?.questions.find((item) => !item.resolved);
                    if (question) {
                        await node.answerQuestion(currentSessionId, question.questionId, [['Vitest']]);
                        await waitForConditionApprovingAll(
                            node,
                            () => {
                                const session = node.state.sessions.get(currentSessionId as string);
                                return !session?.questions.some((item) => !item.resolved);
                            },
                            30000,
                        ).catch(() => {});
                    }
                    artifactAfterCount = getAssistantMessages(node, currentSessionId).length;
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, artifactAfterCount, step.timeoutMs);
                } else if (step.id === 17) {
                    await node.sendRuntimeConfigChange(currentSessionId, {
                        source: 'user',
                        model: CLAUDE_HAIKU_MODEL.modelID,
                    });
                    await sendPrompt(step.prompt!, `step${step.id}`, CLAUDE_HAIKU_MODEL);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 25) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        await waitForPendingPermissionInAnySession(node, 60000);
                        await approvePermissionsIndividuallyUntilSettled(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    } catch {
                        await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    }
                } else if (step.id === 27) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 90000);
                        await holdForCapture('subagent permission prompt', CAPTURE_HOLD_MS, 'component-subagent-permission');
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, { decision: 'once' });
                    } catch {}
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 28) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForPendingPermissionInAnySession(node, 90000);
                    await holdForCapture('pending permission before forced stop', CAPTURE_HOLD_MS, 'component-permission-prompt-pending-stop');
                    resumeSourceSessionId = currentSessionId;
                    await node.stopSession(currentSessionId);
                    await waitForSessionStop(node, currentSessionId, 30000);
                } else if (step.id === 31) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        const assistant = assistantMessagesSince(node, currentSessionId, beforeAssistant);
                        const fullText = assistant.map(getFullText).join(' ');
                        const hasTimeResponse = /\btime\b|:\d{2}|\bam\b|\bpm\b/.test(fullText);
                        const hasBackgroundTool = assistantToolsSince(node, currentSessionId, beforeAssistant).some((tool) =>
                            (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
                            && /donezen|sleep 30/.test(toolText(tool)),
                        );
                        return assistant.some(hasTerminalStepFinish) && hasTimeResponse && hasBackgroundTool;
                    }, step.timeoutMs);
                    await holdForCapture('running background task', CAPTURE_HOLD_MS, 'component-background-running');
                } else if (step.id === 32) {
                    let localBefore = beforeAssistant;
                    await sendPrompt(step.prompt!, `step${step.id}`);

                    const hasCompletedBackgroundOutput = () => assistantToolsSince(node, currentSessionId, localBefore).some((tool) =>
                        (tool.tool === 'TaskOutput' || tool.tool === 'Bash')
                        && tool.state.status === 'completed'
                        && 'output' in tool.state
                        && typeof tool.state.output === 'string'
                        && tool.state.output.includes('donezen'),
                    );

                    const hasTerminalCompletionTurn = () => assistantMessagesSince(node, currentSessionId, localBefore).some((message) =>
                        hasTerminalStepFinish(message)
                        && /donezen|background task (completed|finished)|it's done|output/.test(getFullText(message)),
                    );

                    const hasStillRunningTurn = () => assistantMessagesSince(node, currentSessionId, localBefore).some((message) =>
                        hasTerminalStepFinish(message)
                        && /still running|hasn't been 30 seconds yet|i'll be notified|not finished yet/.test(getFullText(message)),
                    );

                    await waitForConditionApprovingAll(node, () => {
                        if (hasCompletedBackgroundOutput() && hasTerminalCompletionTurn()) {
                            return true;
                        }
                        return hasStillRunningTurn();
                    }, 45000);

                    if (!hasCompletedBackgroundOutput()) {
                        localBefore = getAssistantMessages(node, currentSessionId).length;
                        artifactAfterCount = localBefore;
                        await sendPrompt(
                            'Wait for that same background task to finish, then tell me the output exactly.',
                            'step32-retry',
                        );
                    }

                    await waitForConditionApprovingAll(node, () => {
                        return hasCompletedBackgroundOutput() && hasTerminalCompletionTurn();
                    }, 240000);
                } else if (step.id === 33) {
                    let localBefore = beforeAssistant;
                    await sendPrompt(step.prompt!, `step${step.id}`);

                    const hasStep33Work = () => {
                        const tools = assistantToolsSince(node, currentSessionId, localBefore);
                        const hasStepSpecificBackgroundTool = tools.some((tool) =>
                            (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
                            && /background two|sleep 20/.test(toolText(tool)),
                        );
                        const hasBackgroundComment = existsSync(appJsPath)
                            && readFileSync(appJsPath, 'utf8').includes('// background task test');
                        const hasStepSpecificText = assistantMessagesSince(node, currentSessionId, localBefore).some((message) =>
                            /background two|background task test/.test(getFullText(message)),
                        );
                        return hasStepSpecificBackgroundTool && (hasBackgroundComment || hasStepSpecificText);
                    };

                    try {
                        await waitForConditionApprovingAll(node, () => {
                            if (hasStep33Work()) {
                                return true;
                            }
                            return assistantMessagesSince(node, currentSessionId, localBefore).some((message) =>
                                hasTerminalStepFinish(message)
                                && /background task completion notification|we already/.test(getFullText(message)),
                            );
                        }, 30000);
                    } catch {}

                    if (!hasStep33Work()) {
                        localBefore = getAssistantMessages(node, currentSessionId).length;
                        artifactAfterCount = localBefore;
                        await sendPrompt(
                            'That was the previous background task. Now do this new request: start a NEW background task `sleep 20 && echo "background two"` and, while it is running, add `// background task test` to the top of app.js.',
                            'step33-retry',
                        );
                    }

                    await waitForConditionApprovingAll(node, () => hasStep33Work(), step.timeoutMs);
                } else if (step.id === 35 || step.id === 36 || step.id === 37 || step.id === 38 || step.id === 34) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else {
                    if (!step.prompt) {
                        throw new Error(`Step ${step.id} is missing a prompt`);
                    }
                    await sendPrompt(step.prompt, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs, {
                        autoAnswerQuestions: false,
                    });
                }
            } catch (caught) {
                error = caught instanceof Error ? caught.message : String(caught);
                log(`  ERROR: ${error}`);
            }

            const assistantMessages = getAssistantMessages(node, currentSessionId);
            const textSnippet = collectTextSnippet(assistantMessages, artifactAfterCount);
            const fullText = assistantMessages
                .slice(artifactAfterCount)
                .map((message) => getFullText(message))
                .join(' ');
            const continuityWarning = isContinuityWarningText(`${textSnippet} ${fullText}`);
            const result: StepResult = {
                stepId: step.id,
                name: step.name,
                status: error ? 'fail' : 'pass',
                durationMs: Date.now() - startedAt,
                sessionId: currentSessionId as string,
                tools: collectToolParts(assistantMessages, artifactAfterCount),
                textSnippet,
                continuityWarning,
                error,
                artifactBase: stepFileBase(step),
            };
            results.push(result);

            log(`  ${result.status.toUpperCase()} ${(result.durationMs / 1000).toFixed(1)}s`);
            if (continuityWarning) {
                log('  Continuity warning detected in transcript text');
            }

            await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
            await writeInfo(error ? 'step_failed' : 'running', step);

            if (INTER_STEP_DELAY_MS > 0 && step !== activeSteps[activeSteps.length - 1]) {
                await sleep(INTER_STEP_DELAY_MS);
            }
        }

        await writeFile(DONE_MARKER_FILE, `${new Date().toISOString()}\n`);
        await writeInfo('completed');
        log('Driver completed.');
        if (POST_DONE_HOLD_MS > 0) {
            log(`Holding completed state for ${Math.round(POST_DONE_HOLD_MS / 1000)}s...`);
            await sleep(POST_DONE_HOLD_MS);
        }
    } finally {
        redirectServer?.close();
        if (node) {
            node.disconnect();
        }
        if (webProcess && !webProcess.killed) {
            webProcess.kill('SIGTERM');
        }
        await teardownTestInfrastructure();
    }
}

main().catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    await writeFile(DRIVER_LOG_FILE, `${message}\n`).catch(() => {});
    process.exit(1);
});
