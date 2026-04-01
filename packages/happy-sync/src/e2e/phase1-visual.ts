#!/usr/bin/env npx tsx
/**
 * Phase 1 VISUAL walkthrough — full 38-step browser capture using Playwright.
 *
 * Boots isolated server + daemon + Expo web, drives a real Claude session
 * through the exercise flow, and captures:
 * - one continuous Playwright WebM recording
 * - a full-page screenshot after every step
 * - top/bottom screenshots for every spawned session
 * - accessibility snapshots alongside each PNG
 *
 * Artifacts are written to `e2e-recordings/ux-review/`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

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

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = 19017;
const OUTPUT_DIR = join(REPO_ROOT, 'e2e-recordings', 'ux-review');
const VIDEO_DIR = join(OUTPUT_DIR, 'video');
const INFO_FILE = join(OUTPUT_DIR, 'phase1-visual-info.json');
const RESULTS_FILE = join(OUTPUT_DIR, 'phase1-visual-results.json');
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
    { id: 34, name: 'Full summary', prompt: 'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.', action: 'send', timeoutMs: 300000 },
    { id: 35, name: 'Background subagent (TaskCreate)', prompt: `Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works.`, action: 'send', timeoutMs: 360000 },
    { id: 36, name: 'Check background agent result (TaskOutput)', prompt: 'Did that background research finish? What did it find?', action: 'send', timeoutMs: 360000 },
    { id: 37, name: 'Multiple background tasks', prompt: `Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".`, action: 'send', timeoutMs: 360000 },
    { id: 38, name: 'Final summary', prompt: 'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.', action: 'send', timeoutMs: 300000 },
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

function parseStepBoundary(value: string | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

const START_STEP_ID = parseStepBoundary(process.env.HAPPY_PHASE1_START_STEP);
const END_STEP_ID = parseStepBoundary(process.env.HAPPY_PHASE1_END_STEP);

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

let browser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let page: Page | null = null;
let currentPageUrl = '';

async function initBrowser(): Promise<void> {
    await mkdir(VIDEO_DIR, { recursive: true });
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1080 },
        recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 1080 } },
    });
    page = await browserContext.newPage();
}

async function closeBrowser(): Promise<void> {
    if (browserContext) {
        await browserContext.close();
        browserContext = null;
    }
    if (browser) {
        await browser.close();
        browser = null;
    }
    page = null;
    currentPageUrl = '';

    // Move the recorded video to the output dir as walkthrough.webm
    try {
        const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith('.webm'));
        if (files.length > 0) {
            const dest = join(OUTPUT_DIR, 'walkthrough.webm');
            renameSync(join(VIDEO_DIR, files[0]), dest);
            log(`Video saved: ${dest}`);
        }
    } catch (err) {
        log(`Video move failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function evalBrowserJson<T>(script: string): Promise<T | null> {
    if (!page) return null;
    try {
        const result = await page.evaluate(script);
        if (typeof result === 'string') {
            return JSON.parse(result) as T;
        }
        return result as T;
    } catch {
        return null;
    }
}

function buildChatScrollScript(target: 'newest' | 'oldest' | number | null): string {
    return `(() => {
        const isScrollable = (style, el) => {
            const overflowY = style.overflowY || style.overflow;
            return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 80;
        };
        const composer = Array.from(document.querySelectorAll('textarea, input'))
            .find((el) => {
                const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                return placeholder.includes('type a message') || ariaLabel.includes('type a message');
            });
        const composerRect = composer ? composer.getBoundingClientRect() : null;
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
                let score = area + Math.min(el.scrollHeight, 50000) * 10 + rightBias + widthBias;

                if (composerRect) {
                    const overlapWidth = Math.max(0, Math.min(rect.right, composerRect.right) - Math.max(rect.left, composerRect.left));
                    const overlapRatio = composerRect.width > 0 ? overlapWidth / composerRect.width : 0;
                    const verticalGap = composerRect.top - rect.bottom;
                    const centerDelta = Math.abs(centerX - (composerRect.left + composerRect.width / 2));

                    if (rect.bottom > composerRect.top + 24) return null;
                    if (overlapRatio < 0.45) return null;

                    score += overlapRatio * 1_500_000;
                    score += verticalGap >= -16 && verticalGap <= 220 ? 400_000 : 0;
                    score -= centerDelta * 1_500;
                }

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
    if (!page) return;
    if (currentPageUrl !== url) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
            page!.goto(url, { waitUntil: 'load', timeout: 30000 }),
        );
        currentPageUrl = url;
    } else {
        await page.reload({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    }
    await page.waitForTimeout(1500);
}

async function getPageSnapshot(): Promise<string> {
    if (!page) return '';
    try {
        // Use ariaSnapshot for structured accessibility info
        const snapshot = await page.locator('body').ariaSnapshot();
        return snapshot || 'Empty page';
    } catch {
        // Fallback: get page text content
        try {
            const text = await page.textContent('body');
            return text?.slice(0, 8000) ?? 'Empty page';
        } catch {
            return 'Empty page';
        }
    }
}

async function captureBrowserState(
    basename: string,
    opts: { url: string; fullPage?: boolean; scroll?: 'top' | 'bottom' | 'none'; chatScrollTop?: number },
): Promise<string> {
    await ensureBrowserOn(opts.url);

    if (typeof opts.chatScrollTop === 'number') {
        await scrollChatTranscript(opts.chatScrollTop);
        await page!.waitForTimeout(1500);
    } else if (opts.scroll === 'top') {
        await scrollChatTranscript('oldest');
        await page!.waitForTimeout(1500);
    } else if (opts.scroll === 'bottom') {
        await scrollChatTranscript('newest');
        await page!.waitForTimeout(1500);
    }

    const screenshotPath = join(OUTPUT_DIR, `${basename}.png`);
    const snapshotPath = join(OUTPUT_DIR, `${basename}.snapshot.txt`);
    await page!.screenshot({ path: screenshotPath, fullPage: opts.fullPage ?? false });
    const snapshot = await getPageSnapshot();
    await writeFile(snapshotPath, snapshot);
    return snapshot;
}

async function captureSessionTranscript(prefix: string, url: string): Promise<void> {
    if (!page) return;
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
    let lastLogAt = 0;
    let lastAssistantSignature = '';
    let stableSince = Date.now();
    await waitForConditionApprovingAll(
        node,
        () => {
            const assistant = assistantMessagesSince(node, sessionId, afterCount);
            if (assistant.length === 0) {
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

            if (assistant.some(hasTerminalStepFinish)) {
                return true;
            }

            const session = node.state.sessions.get(sessionId as string);
            if (!session) {
                return false;
            }

            const tools = assistant.flatMap(getToolParts);
            const allToolsTerminal = tools.every((tool) => isTerminalToolStatus(tool.state.status));
            const noPendingPrompts = !session.permissions.some((permission) => !permission.resolved)
                && !session.questions.some((question) => !question.resolved);
            const sessionSettled = session.status.type === 'idle'
                || session.status.type === 'completed'
                || session.status.type === 'error';
            const lastMessageHasVisibleContent = assistant.some((message) =>
                getTextParts(message).length > 0 || getToolParts(message).length > 0,
            );

            return sessionSettled
                && noPendingPrompts
                && allToolsTerminal
                && lastMessageHasVisibleContent
                && Date.now() - stableSince >= 3000;
        },
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
    await rm(OUTPUT_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(OUTPUT_DIR, { recursive: true });
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

        log('Launching Playwright browser with video recording...');
        await initBrowser();
        await ensureBrowserOn(makeSessionUrl(currentSessionId as string));
        await page!.waitForTimeout(2500);

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

        const activeSteps = STEPS.slice(1).filter((step) => {
            if (START_STEP_ID !== null && step.id < START_STEP_ID) {
                return false;
            }
            if (END_STEP_ID !== null && step.id > END_STEP_ID) {
                return false;
            }
            return true;
        });

        for (const step of activeSteps) {
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
                    // Set resumeSourceSessionId BEFORE the wait so resume step
                    // can work even if the cancel wait times out.
                    resumeSourceSessionId = currentSessionId;
                    await sendPrompt(step.prompt, `step${step.id}`);
                    // Wait briefly for Claude to start processing, then stop.
                    try {
                        await waitForCondition(
                            () => getAssistantMessages(node, currentSessionId).length > beforeAssistant,
                            15000,
                        );
                    } catch {
                        log('  Cancel: Claude did not start responding in 15s, stopping anyway.');
                    }
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
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                } else if (step.id === 35) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    await captureBrowserState('component-taskcreate', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 36) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    await captureBrowserState('component-taskoutput', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 37) {
                    await sendPrompt(step.prompt!, `step${step.id}`);
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    await captureBrowserState('component-multiple-background-tasks', {
                        url: makeSessionUrl(currentSessionId as string),
                        fullPage: false,
                        scroll: 'bottom',
                    });
                } else if (step.id === 38) {
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

            try {
                snapshotText = await captureBrowserState(stepFileBase(step), {
                    url: makeSessionUrl(currentSessionId as string),
                    fullPage: false,
                    scroll: 'bottom',
                });
            } catch (screenshotErr) {
                log(`  Screenshot failed: ${screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr)}`);
            }

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
            try {
                await captureSessionTranscript(prefix, makeSessionUrl(sessionId));
            } catch (err) {
                log(`  Session transcript capture failed for ${prefix}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        try {
            await captureBrowserState('home-session-list', {
                url: homeUrl,
                fullPage: true,
                scroll: 'none',
            });
        } catch (err) {
            log(`  Home session list capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        await closeBrowser();
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
            await closeBrowser();
        } catch {}
        await teardownTestInfrastructure();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
