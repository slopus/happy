#!/usr/bin/env npx tsx
/**
 * Phase 1 VISUAL walkthrough — full 38-step browser capture using agent-browser.
 *
 * Boots isolated server + daemon + Expo web, drives a real Claude session
 * through the exercise flow, and captures:
 * - one continuous agent-browser WebM recording
 * - a full-page screenshot after every step
 * - top/bottom screenshots for every spawned session
 * - accessibility snapshots alongside each PNG
 *
 * Artifacts are written to `e2e-recordings/ux-review/`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SyncNode } from '../sync-node';
import type { MessageWithParts, Part, SessionID } from '../protocol';
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

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = 19017;
const OUTPUT_DIR = join(REPO_ROOT, 'e2e-recordings', 'ux-review');
const INFO_FILE = join(OUTPUT_DIR, 'phase1-visual-info.json');
const RESULTS_FILE = join(OUTPUT_DIR, 'phase1-visual-results.json');
const VIDEO_FILE = join(OUTPUT_DIR, 'walkthrough.webm');
const AGENT_BROWSER_BIN = process.env.AGENT_BROWSER_BIN ?? 'agent-browser';
const AGENT_BROWSER_SESSION = `happy-phase1-visual-${process.pid}`;
const CLAUDE_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };
const CLAUDE_HAIKU_MODEL = { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' };

type StepAction = 'send' | 'stop' | 'cancel' | 'resume' | 'model-switch';

interface StepDef {
    id: number;
    name: string;
    prompt: string | null;
    action: StepAction;
    timeoutMs: number;
}

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
    screenshot: string;
    snapshot: string;
}

interface ChatScrollInfo {
    found: boolean;
    inverted?: boolean;
    scrollTop?: number;
    maxScrollTop?: number;
    scrollHeight?: number;
    clientHeight?: number;
    width?: number;
    height?: number;
    left?: number;
}

const STEPS: StepDef[] = [
    { id: 0, name: 'Open the agent', prompt: null, action: 'send', timeoutMs: 0 },
    { id: 1, name: 'Orient', prompt: 'Read all files, tell me what this does.', action: 'send', timeoutMs: 120000 },
    { id: 2, name: 'Find the bug', prompt: "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line.", action: 'send', timeoutMs: 90000 },
    { id: 3, name: 'Edit rejected', prompt: 'Fix it.', action: 'send', timeoutMs: 180000 },
    { id: 4, name: 'Edit approved once', prompt: 'Ok that diff looks right. Go ahead and apply it.', action: 'send', timeoutMs: 180000 },
    { id: 5, name: 'Edit approved always', prompt: 'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.', action: 'send', timeoutMs: 180000 },
    { id: 6, name: 'Auto-approved edit', prompt: 'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.', action: 'send', timeoutMs: 240000 },
    { id: 7, name: 'Search the web', prompt: 'Search the web for best practices on accessible keyboard shortcuts in todo apps.', action: 'send', timeoutMs: 180000 },
    { id: 8, name: 'Parallel explore', prompt: "I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.", action: 'send', timeoutMs: 300000 },
    { id: 9, name: 'Simple edit', prompt: "Add Cmd+Enter to submit the form from anywhere on the page. That's it, nothing else.", action: 'send', timeoutMs: 180000 },
    { id: 10, name: 'Cancel', prompt: 'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.', action: 'cancel', timeoutMs: 60000 },
    { id: 11, name: 'Resume after cancel', prompt: 'Ok just the Cmd+Enter. Do that.', action: 'resume', timeoutMs: 180000 },
    { id: 12, name: 'Agent asks a question', prompt: 'I want to add a test framework. Ask me which one I want before you set anything up.', action: 'send', timeoutMs: 180000 },
    { id: 13, name: 'Act on the answer', prompt: 'Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).', action: 'send', timeoutMs: 300000 },
    { id: 14, name: 'Read outside project', prompt: 'What files are in the parent directory?', action: 'send', timeoutMs: 120000 },
    { id: 15, name: 'Write outside project', prompt: 'Create a file at `../outside-test.txt` with the content "boundary test".', action: 'send', timeoutMs: 120000 },
    { id: 16, name: 'Create todos', prompt: 'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.', action: 'send', timeoutMs: 120000 },
    { id: 17, name: 'Switch and edit', prompt: 'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.', action: 'model-switch', timeoutMs: 240000 },
    { id: 18, name: 'Compact', prompt: 'Compact the context.', action: 'send', timeoutMs: 120000 },
    { id: 19, name: 'Post-compaction sanity', prompt: 'What files have we changed so far?', action: 'send', timeoutMs: 120000 },
    { id: 20, name: 'Close', prompt: null, action: 'stop', timeoutMs: 20000 },
    { id: 21, name: 'Reopen', prompt: null, action: 'resume', timeoutMs: 60000 },
    { id: 22, name: 'Verify continuity', prompt: 'What was the last thing we were working on?', action: 'send', timeoutMs: 180000 },
    { id: 23, name: 'Mark todo done', prompt: 'Mark the "add due dates" todo as completed — we just did that.', action: 'send', timeoutMs: 180000 },
    { id: 25, name: 'Multiple permissions in one turn', prompt: 'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.', action: 'send', timeoutMs: 240000 },
    { id: 26, name: 'Supersede pending permissions', prompt: 'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".', action: 'send', timeoutMs: 240000 },
    { id: 27, name: 'Subagent hits a permission wall', prompt: `Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don't auto-approve anything for it.`, action: 'send', timeoutMs: 300000 },
    { id: 28, name: 'Stop session while permission is pending', prompt: 'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.', action: 'send', timeoutMs: 180000 },
    { id: 29, name: 'Resume after forced stop', prompt: 'What happened with the priority feature?', action: 'resume', timeoutMs: 240000 },
    { id: 30, name: 'Retry after stop', prompt: 'Try again — add the priority field. Approve everything this time.', action: 'send', timeoutMs: 240000 },
    { id: 31, name: 'Launch background task', prompt: `Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it's running, tell me what time it is.`, action: 'send', timeoutMs: 180000 },
    { id: 32, name: 'Background task completes', prompt: 'Did that background task finish? What was the output?', action: 'send', timeoutMs: 240000 },
    { id: 33, name: 'Interact during background task', prompt: `Run another background task: sleep 20 && echo "background two". While that's running, add a comment to the top of app.js saying "// background task test".`, action: 'send', timeoutMs: 240000 },
    { id: 34, name: 'Full summary', prompt: 'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.', action: 'send', timeoutMs: 180000 },
    { id: 35, name: 'Background subagent (TaskCreate)', prompt: `Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works.`, action: 'send', timeoutMs: 300000 },
    { id: 36, name: 'Check background agent result (TaskOutput)', prompt: 'Did that background research finish? What did it find?', action: 'send', timeoutMs: 300000 },
    { id: 37, name: 'Multiple background tasks', prompt: `Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".`, action: 'send', timeoutMs: 300000 },
    { id: 38, name: 'Final summary', prompt: 'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.', action: 'send', timeoutMs: 180000 },
];

function log(message: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${message}`);
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function sanitizeSegment(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
}

function stepFileBase(step: StepDef): string {
    return `step-${String(step.id).padStart(2, '0')}-${sanitizeSegment(step.name)}`;
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
        .slice(0, 400);
}

function hasTerminalStepFinish(message: MessageWithParts): boolean {
    return message.parts.some(
        (part) => part.type === 'step-finish' && part.reason !== 'tool-calls',
    );
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

async function runCommand(
    command: string,
    args: string[],
    opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: opts.cwd ?? REPO_ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0 || opts.allowFailure) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new Error(`${command} ${args.join(' ')} failed with code ${code}\n${stdout}\n${stderr}`));
        });
    });
}

let browserUrl = '';

async function runAgentBrowser(args: string[], allowFailure = false): Promise<string> {
    const result = await runCommand(
        AGENT_BROWSER_BIN,
        ['--session', AGENT_BROWSER_SESSION, ...args],
        { allowFailure },
    );
    return `${result.stdout}${result.stderr}`.trim();
}

function parseAgentBrowserJson<T>(raw: string): T | null {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    try {
        return JSON.parse(trimmed) as T;
    } catch {}

    try {
        return JSON.parse(JSON.parse(trimmed) as string) as T;
    } catch {
        return null;
    }
}

async function evalBrowserJson<T>(script: string): Promise<T | null> {
    const raw = await runAgentBrowser(['eval', script], true);
    return parseAgentBrowserJson<T>(raw);
}

function buildChatScrollScript(target: 'newest' | 'oldest' | number | null): string {
    return `(() => {
        const isScrollable = (style, el) => {
            const overflowY = style.overflowY || style.overflow;
            return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 80;
        };
        const candidates = Array.from(document.querySelectorAll('div, [role="list"]'))
            .map((el) => {
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                if (!isScrollable(style, el)) return null;
                if (rect.width < window.innerWidth * 0.28) return null;
                if (rect.height < window.innerHeight * 0.22) return null;
                const area = rect.width * rect.height;
                const centerX = rect.left + rect.width / 2;
                const rightBias = centerX > window.innerWidth * 0.45 ? 500000 : 0;
                const widthBias = rect.width > window.innerWidth * 0.45 ? 250000 : 0;
                const score = area + Math.min(el.scrollHeight, 50000) * 10 + rightBias + widthBias;
                return { el, rect, score };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
        const best = candidates[0];
        if (!best) {
            return JSON.stringify({ found: false });
        }

        const el = best.el;
        const rect = best.rect;
        // The transcript DOM uses an inverted transform, but the actual scroll
        // mapping behaves like a normal list on web: scrollTop=0 shows the
        // oldest visible content and maxScrollTop shows the latest content.
        const inverted = false;
        const maxScrollTop = Math.max(el.scrollHeight - el.clientHeight, 0);
        const target = ${target === null ? 'null' : JSON.stringify(target)};

        if (target !== null) {
            let nextScrollTop;
            if (target === 'oldest') {
                nextScrollTop = inverted ? maxScrollTop : 0;
            } else if (target === 'newest') {
                nextScrollTop = inverted ? 0 : maxScrollTop;
            } else {
                nextScrollTop = Number(target);
            }
            el.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
            el.dispatchEvent(new Event('scroll', { bubbles: true }));
        }

        return JSON.stringify({
            found: true,
            inverted,
            scrollTop: el.scrollTop,
            maxScrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            width: rect.width,
            height: rect.height,
            left: rect.left,
        });
    })()`;
}

async function scrollChatTranscript(target: 'newest' | 'oldest' | number): Promise<ChatScrollInfo | null> {
    return evalBrowserJson<ChatScrollInfo>(buildChatScrollScript(target));
}

async function getChatScrollInfo(): Promise<ChatScrollInfo | null> {
    return evalBrowserJson<ChatScrollInfo>(buildChatScrollScript(null));
}

async function ensureBrowserOn(url: string): Promise<void> {
    if (browserUrl !== url) {
        await runAgentBrowser(['open', url]);
        browserUrl = url;
    } else {
        await runAgentBrowser(['reload'], true);
    }
    await runAgentBrowser(['wait', '1500'], true);
}

async function captureBrowserState(
    basename: string,
    opts: { url: string; fullPage?: boolean; scroll?: 'top' | 'bottom' | 'none'; chatScrollTop?: number },
): Promise<string> {
    await ensureBrowserOn(opts.url);

    if (typeof opts.chatScrollTop === 'number') {
        await scrollChatTranscript(opts.chatScrollTop);
        await runAgentBrowser(['wait', '1500'], true);
    } else if (opts.scroll === 'top') {
        await scrollChatTranscript('oldest');
        await runAgentBrowser(['wait', '1500'], true);
    } else if (opts.scroll === 'bottom') {
        await scrollChatTranscript('newest');
        await runAgentBrowser(['wait', '1500'], true);
    }

    const screenshotPath = join(OUTPUT_DIR, `${basename}.png`);
    const snapshotPath = join(OUTPUT_DIR, `${basename}.snapshot.txt`);
    const screenshotArgs = ['screenshot', screenshotPath];
    if (opts.fullPage) {
        screenshotArgs.push('--full');
    }
    await runAgentBrowser(screenshotArgs);
    const snapshot = await runAgentBrowser(['snapshot', '--compact', '--depth', '8'], true);
    await writeFile(snapshotPath, snapshot);
    return snapshot;
}

async function captureSessionTranscript(prefix: string, url: string): Promise<void> {
    await ensureBrowserOn(url);
    const info = await getChatScrollInfo();
    if (!info?.found || !info.clientHeight || info.maxScrollTop === undefined) {
        await captureBrowserState(`${prefix}-segment-01`, {
            url,
            fullPage: false,
            scroll: 'bottom',
        });
        return;
    }

    const stepSize = Math.max(Math.floor(info.clientHeight * 0.82), 240);
    const positions: number[] = [];

    if (info.inverted) {
        for (let pos = info.maxScrollTop; pos >= 0; pos -= stepSize) {
            positions.push(pos);
        }
        if (positions[positions.length - 1] !== 0) {
            positions.push(0);
        }
    } else {
        for (let pos = 0; pos <= info.maxScrollTop; pos += stepSize) {
            positions.push(pos);
        }
        if (positions[positions.length - 1] !== info.maxScrollTop) {
            positions.push(info.maxScrollTop);
        }
    }

    const uniquePositions = positions.filter((value, index) => index === 0 || value !== positions[index - 1]);
    for (const [index, position] of uniquePositions.entries()) {
        await captureBrowserState(`${prefix}-segment-${String(index + 1).padStart(2, '0')}`, {
            url,
            fullPage: false,
            scroll: 'none',
            chatScrollTop: position,
        });
    }
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
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                const body = await response.text();
                if (body.includes('Happy')) {
                    return;
                }
            }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Web app not ready after ${timeoutMs}ms`);
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
    await waitForConditionApprovingAll(
        node,
        () => assistantMessagesSince(node, sessionId, afterCount).some(hasTerminalStepFinish),
        timeoutMs,
        opts,
    );
}

async function waitForPendingPermissionInAnySession(
    node: SyncNode,
    timeoutMs: number,
): Promise<{ sessionId: SessionID; permission: any }> {
    await waitForCondition(() => {
        return Array.from(node.state.sessions.values()).some((session) =>
            session.permissions.some((permission) => !permission.resolved),
        );
    }, timeoutMs);

    for (const session of node.state.sessions.values()) {
        const permission = session.permissions.find((item) => !item.resolved);
        if (permission) {
            return { sessionId: session.info.id, permission };
        }
    }
    throw new Error('Permission appeared and disappeared before it could be captured');
}

async function main(): Promise<void> {
    await mkdir(OUTPUT_DIR, { recursive: true });
    await rm(VIDEO_FILE, { force: true }).catch(() => {});
    process.env.HAPPY_TEST_SERVER_PORT = '34191';

    let webProcess: ChildProcess | null = null;
    let node!: SyncNode;
    const results: StepResult[] = [];

    try {
        log('Booting isolated server + daemon...');
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
            return `http://127.0.0.1:${WEB_PORT}/session/${sessionId}?dev_token=${encodeURIComponent(getAuthToken())}&dev_secret=${encodeURIComponent(secret64url)}`;
        };
        const homeUrl = (() => {
            const secret64url = encodeBase64Url(getEncryptionSecret());
            return `http://127.0.0.1:${WEB_PORT}/?dev_token=${encodeURIComponent(getAuthToken())}&dev_secret=${encodeURIComponent(secret64url)}`;
        })();

        log('Spawning initial Claude session via daemon...');
        let currentSessionId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(currentSessionId as string), 30000);
        let resumeSourceSessionId: SessionID | null = null;
        const allSessionIds: string[] = [currentSessionId as string];

        const writeInfo = async (status: string, currentStep?: StepDef) => {
            await writeFile(INFO_FILE, JSON.stringify({
                status,
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
            }, null, 2));
        };

        await writeInfo('booted');

        log('Starting agent-browser recording...');
        await runAgentBrowser(['record', 'stop'], true);
        await runAgentBrowser(['close'], true);
        await runAgentBrowser(['set', 'viewport', '1440', '1080']);
        await runAgentBrowser(['record', 'start', VIDEO_FILE, makeSessionUrl(currentSessionId as string)]);
        browserUrl = makeSessionUrl(currentSessionId as string);
        await runAgentBrowser(['wait', '2500'], true);

        const step0 = STEPS[0];
        await captureBrowserState(stepFileBase(step0), {
            url: makeSessionUrl(currentSessionId as string),
            fullPage: false,
            scroll: 'bottom',
        });
        results.push({
            stepId: 0,
            name: step0.name,
            status: 'pass',
            durationMs: 0,
            sessionId: currentSessionId as string,
            tools: [],
            textSnippet: '',
            continuityWarning: false,
            error: null,
            screenshot: `${stepFileBase(step0)}.png`,
            snapshot: `${stepFileBase(step0)}.snapshot.txt`,
        });
        await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
        await writeInfo('running', step0);

        for (const step of STEPS.slice(1)) {
            const startedAt = Date.now();
            let error: string | null = null;
            const sessionBeforeStep = currentSessionId as string;
            const beforeAssistant = getAssistantMessages(node, currentSessionId).length;
            let artifactAfterCount = beforeAssistant;
            let snapshotText = '';

            log(`Step ${step.id} — ${step.name}`);
            await writeInfo('running', step);

            try {
                const sendPrompt = async (
                    prompt: string,
                    msgId: string,
                    model = CLAUDE_MODEL,
                ) => {
                    await node.sendMessage(currentSessionId, makeUserMessage(msgId, currentSessionId, prompt, 'claude', model));
                };

                if (step.action === 'cancel') {
                    if (!step.prompt) throw new Error('Cancel step missing prompt');
                    await sendPrompt(step.prompt, `step${step.id}`);
                    await waitForCondition(
                        () => getAssistantMessages(node, currentSessionId).length > beforeAssistant,
                        30000,
                    );
                    resumeSourceSessionId = currentSessionId;
                    await node.stopSession(currentSessionId);
                } else if (step.action === 'stop') {
                    resumeSourceSessionId = currentSessionId;
                    await node.stopSession(currentSessionId);
                } else if (step.action === 'resume') {
                    if (!resumeSourceSessionId) {
                        throw new Error(`No stopped session available to resume for step ${step.id}`);
                    }
                    currentSessionId = await spawnSessionViaDaemon({
                        directory: projectDir,
                        agent: 'claude',
                        sessionId: resumeSourceSessionId,
                    }) as SessionID;
                    await waitForCondition(() => node.state.sessions.has(currentSessionId as string), 30000);
                    allSessionIds.push(currentSessionId as string);
                    await ensureBrowserOn(makeSessionUrl(currentSessionId as string));

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
                        await captureBrowserState('component-permission-prompt-denied', {
                            url: makeSessionUrl(pending.sessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                        await node.denyPermission(pending.sessionId, pending.permission.permissionId, {
                            reason: 'No — show me the diff first.',
                        });
                        await sendPrompt('No — show me the diff first.', 'step3-followup');
                    } catch {
                        log('  No permission prompt appeared for Step 3; accepting text-only recovery path.');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 4) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 30000);
                        await captureBrowserState('component-permission-prompt-approve-once', {
                            url: makeSessionUrl(pending.sessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, { decision: 'once' });
                    } catch {
                        log('  No permission prompt appeared for Step 4; waiting for Claude text/tool response.');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 5) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 30000);
                        await captureBrowserState('component-permission-prompt-approve-always', {
                            url: makeSessionUrl(pending.sessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, {
                            decision: 'always',
                            allowTools: [pending.permission.block.permission],
                        });
                    } catch {
                        log('  No permission prompt appeared for Step 5; waiting for Claude text/tool response.');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 12) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    let answered = false;
                    try {
                        await waitForPendingQuestion(node, currentSessionId, 60000);
                        await captureBrowserState('component-question-prompt', {
                            url: makeSessionUrl(currentSessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                        const question = node.state.sessions.get(currentSessionId as string)?.questions.find((item) => !item.resolved);
                        if (question) {
                            await node.answerQuestion(currentSessionId, question.questionId, [['Vitest']]);
                            answered = true;
                        }
                    } catch {
                        await waitForConditionApprovingAll(
                            node,
                            () => assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) => {
                                const text = getFullText(message).toLowerCase();
                                return text.includes('which one') || text.includes('vitest') || hasTerminalStepFinish(message);
                            }),
                            60000,
                        );
                        await captureBrowserState('component-question-prompt-text', {
                            url: makeSessionUrl(currentSessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                    }

                    if (!answered) {
                        await sendPrompt('Vitest', 'step12-answer');
                    }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
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
                        await captureBrowserState('component-multiple-permissions', {
                            url: makeSessionUrl(currentSessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                    } catch {}
                    await waitForConditionApprovingAll(
                        node,
                        () => assistantMessagesSince(node, currentSessionId, beforeAssistant).some(hasTerminalStepFinish),
                        step.timeoutMs,
                    );
                } else if (step.id === 27) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    try {
                        const pending = await waitForPendingPermissionInAnySession(node, 90000);
                        await captureBrowserState('component-subagent-permission', {
                            url: makeSessionUrl(pending.sessionId as string),
                            fullPage: false,
                            scroll: 'bottom',
                        });
                        await node.approvePermission(pending.sessionId, pending.permission.permissionId, { decision: 'once' });
                    } catch {}
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 28) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    const pending = await waitForPendingPermissionInAnySession(node, 90000);
                    await captureBrowserState('component-permission-prompt-pending-stop', {
                        url: makeSessionUrl(pending.sessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                    resumeSourceSessionId = currentSessionId;
                    await node.stopSession(currentSessionId);
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
                    await captureBrowserState('component-background-running', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
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
                        await sendPrompt('Wait for that same background task to finish, then tell me the output exactly.', 'step32-retry');
                    }

                    await waitForConditionApprovingAll(node, () => {
                        return hasCompletedBackgroundOutput() && hasTerminalCompletionTurn();
                    }, 240000);
                    await captureBrowserState('component-background-completed', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
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
                        await sendPrompt('That was the previous background task. Now do this new request: start a NEW background task `sleep 20 && echo "background two"` and, while it is running, add `// background task test` to the top of app.js.', 'step33-retry');
                    }

                    await waitForConditionApprovingAll(node, () => hasStep33Work(), step.timeoutMs);
                    await captureBrowserState('component-background-concurrent', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 34) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        return assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) => {
                            const text = getFullText(message);
                            return hasTerminalStepFinish(message)
                                && text.length > 50
                                && /(git|summary|modified|changed|added|removed|app\.js|index\.html|styles\.css)/.test(text);
                        });
                    }, step.timeoutMs);
                } else if (step.id === 35) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        return assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) =>
                            hasTerminalStepFinish(message) && getFullText(message).length > 30,
                        );
                    }, step.timeoutMs);
                    await captureBrowserState('component-taskcreate', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 36) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        return assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) =>
                            hasTerminalStepFinish(message) && getFullText(message).length > 30,
                        );
                    }, step.timeoutMs);
                    await captureBrowserState('component-taskoutput', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 37) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        const tools = assistantToolsSince(node, currentSessionId, beforeAssistant);
                        const hasEdit = tools.some((tool) =>
                            (tool.tool === 'Edit' || tool.tool === 'Write')
                            && (tool.state.status === 'completed' || tool.state.status === 'error'),
                        );
                        const hasComment = existsSync(appJsPath)
                            && readFileSync(appJsPath, 'utf8').includes('// multi-task test');
                        const hasTerminal = assistantMessagesSince(node, currentSessionId, beforeAssistant).some(hasTerminalStepFinish);
                        return hasTerminal && (hasEdit || hasComment);
                    }, step.timeoutMs);
                    await captureBrowserState('component-multiple-background-tasks', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 38) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForConditionApprovingAll(node, () => {
                        return assistantMessagesSince(node, currentSessionId, beforeAssistant).some((message) => {
                            const text = getFullText(message);
                            return hasTerminalStepFinish(message)
                                && text.length > 50
                                && /(summary|modified|changed|files|app\.js)/.test(text);
                        });
                    }, step.timeoutMs);
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

            snapshotText = await captureBrowserState(stepFileBase(step), {
                url: makeSessionUrl(currentSessionId as string),
                fullPage: false,
                scroll: 'bottom',
            });

            const assistantMessages = getAssistantMessages(node, currentSessionId);
            const continuityWarning = /don't have (any )?context|no context from the previous session|start from scratch/i.test(snapshotText);
            const result: StepResult = {
                stepId: step.id,
                name: step.name,
                status: error ? 'fail' : 'pass',
                durationMs: Date.now() - startedAt,
                sessionId: currentSessionId as string,
                tools: collectToolParts(assistantMessages, artifactAfterCount),
                textSnippet: collectTextSnippet(assistantMessages, artifactAfterCount),
                continuityWarning,
                error,
                screenshot: `${stepFileBase(step)}.png`,
                snapshot: `${stepFileBase(step)}.snapshot.txt`,
            };
            results.push(result);

            log(`  ${result.status.toUpperCase()} ${(result.durationMs / 1000).toFixed(1)}s (${sessionBeforeStep} -> ${result.sessionId})`);
            if (continuityWarning) {
                log('  Continuity warning detected in browser snapshot');
            }

            await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
            await writeInfo(error ? 'step_failed' : 'running', step);
        }

        for (const [index, sessionId] of allSessionIds.entries()) {
            const prefix = `session-${String(index + 1).padStart(2, '0')}`;
            await captureSessionTranscript(prefix, makeSessionUrl(sessionId));
        }

        await captureBrowserState('home-session-list', {
            url: homeUrl,
            fullPage: true,
            scroll: 'none',
        });

        await runAgentBrowser(['record', 'stop'], true);
        await runAgentBrowser(['close'], true);
        await writeInfo('completed');
        log(`Saved artifacts to ${OUTPUT_DIR}`);
    } finally {
        if (node) {
            node.disconnect();
        }
        if (webProcess && !webProcess.killed) {
            webProcess.kill('SIGTERM');
        }
        try {
            await runAgentBrowser(['record', 'stop'], true);
        } catch {}
        try {
            await runAgentBrowser(['close'], true);
        } catch {}
        await teardownTestInfrastructure();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
