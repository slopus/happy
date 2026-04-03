/**
 * Level 3: Browser smoke verification for the two key agents.
 *
 * Boots the real standalone server + daemon from the Level 2 harness, starts
 * the real Happy web app, then opens a real Claude/Codex session in Chrome.
 * The browser asserts that the transcript hydrates and renders a real tool-
 * heavy response instead of failing inside the web SyncNode path.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { MessageWithParts, SessionID } from '../v3-compat';
import {
    bootTestInfrastructure,
    createIsolatedProjectCopy,
    getAuthToken,
    getEncryptionSecret,
    getServerUrl,
    spawnSessionViaDaemon,
    teardownTestInfrastructure,
} from './setup';
import {
    getAssistantMessages,
    getTextParts,
    getToolParts,
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    resolveSessionKeyMaterial,
    waitForCondition,
    waitForStepFinish,
} from './helpers';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = Number(process.env.HAPPY_BROWSER_WEB_PORT ?? '19006');
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const VIDEO_DIR = join(REPO_ROOT, 'e2e-recordings');
const STEP_TIMEOUT = 240000;
const EXPO_SHELL_TEXT = 'You need to enable JavaScript to run this app.';

const CLAUDE_MODEL = {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-20250514',
};

const CODEX_MODEL = {
    providerID: 'openai',
    modelID: 'codex-mini-latest',
};

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function normalizeVisibleText(input: string): string {
    return input
        .replace(/[*_`#[\]]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getBrowserTranscriptSnippet(messages: MessageWithParts[]): string | null {
    for (const part of messages.flatMap(getTextParts)) {
        const normalized = normalizeVisibleText(part.text);
        if (normalized.length === 0) {
            continue;
        }

        return normalized.slice(0, 80);
    }

    return null;
}

async function waitForWebAppReady(url: string, timeoutMs = 120000): Promise<void> {
    const start = Date.now();
    let lastHtml = '';
    let lastBundleUrl = '';
    let lastBundleError = '';
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            const body = await response.text();
            lastHtml = body;
            if (response.ok && body.includes('Happy')) {
                const bundlePath = body.match(/<script[^>]+src="([^"]+\.bundle[^"]*)"[^>]*><\/script>/i)?.[1];
                if (!bundlePath) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }

                lastBundleUrl = new URL(bundlePath, url).toString();
                const remaining = Math.max(timeoutMs - (Date.now() - start), 1000);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), remaining);
                try {
                    const bundleResponse = await fetch(lastBundleUrl, { signal: controller.signal });
                    if (bundleResponse.ok) {
                        bundleResponse.body?.cancel().catch(() => {});
                        return;
                    }

                    lastBundleError = await bundleResponse.text();
                } finally {
                    clearTimeout(timer);
                }
            }
        } catch (error) {
            lastBundleError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Web app not ready at ${url} after ${timeoutMs}ms\n` +
        `Last bundle URL: ${lastBundleUrl || '<none>'}\n` +
        `Last bundle error: ${lastBundleError.slice(0, 2000) || '<none>'}\n` +
        `Last HTML (first 1000 chars): ${lastHtml.slice(0, 1000)}`,
    );
}

async function gotoHydratedPage(
    page: Page,
    url: string,
    expectedTexts: string[],
    timeoutMs = 90000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    let attempts = 0;

    while (Date.now() < deadline) {
        attempts += 1;
        const remaining = deadline - Date.now();
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(remaining, 1000),
        });

        try {
            return await waitForBodyText(page, expectedTexts, Math.min(remaining, 30000));
        } catch (error) {
            lastError = error;
            const body = await readBodyText(page);
            const stuckOnShell = body.includes(EXPO_SHELL_TEXT)
                && !expectedTexts.every((text) => body.includes(text));
            if (!stuckOnShell) {
                break;
            }

            await page.waitForTimeout(1500);
        }
    }

    throw new Error(
        `Failed to load hydrated page after ${attempts} attempt(s): ${url}\n` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
}

async function readBodyText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const body = (globalThis as { document?: { body?: { innerText?: string } } }).document?.body;
        return body?.innerText ?? '';
    });
}

async function waitForBodyText(
    page: Page,
    expectedTexts: string[],
    timeoutMs = 60000,
): Promise<string> {
    try {
        await page.waitForFunction(
            (texts: string[]) => {
                const body = (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? '';
                return texts.every((text) => body.includes(text));
            },
            expectedTexts,
            { timeout: timeoutMs },
        );
    } catch (error) {
        const body = await readBodyText(page);
        throw new Error(
            `Timed out waiting for body text: ${expectedTexts.join(' | ')}\n` +
            `URL: ${page.url()}\n` +
            `Body (first 2000 chars): ${body.slice(0, 2000)}\n` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return readBodyText(page);
}

function startWebAppServer(serverUrl: string): {
    process: ChildProcess;
    getLog: () => string;
} {
    let log = '';
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

    child.stdout?.on('data', (chunk) => {
        log += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
        log += String(chunk);
    });

    return {
        process: child,
        getLog: () => log,
    };
}

async function createRecordedBrowserPage(opts: {
    viewport: { width: number; height: number };
}): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
    consoleMessages: string[];
    pageErrors: string[];
}> {
    await mkdir(VIDEO_DIR, { recursive: true });

    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    const browser = await chromium.launch({
        headless: true,
        channel: process.env.HAPPY_BROWSER_CHANNEL ?? 'chrome',
    });
    const context = await browser.newContext({
        viewport: opts.viewport,
        recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();

    page.on('console', (message) => {
        consoleMessages.push(`[${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
        pageErrors.push(error.stack || error.message);
    });

    return {
        browser,
        context,
        page,
        consoleMessages,
        pageErrors,
    };
}

function makeAuthenticatedUrl(pathname: string): string {
    return (
        `${WEB_URL}${pathname}` +
        `?dev_token=${encodeURIComponent(getAuthToken())}` +
        `&dev_secret=${encodeURIComponent(encodeBase64Url(getEncryptionSecret()))}`
    );
}

function assertNoCriticalBrowserErrors(consoleMessages: string[], pageErrors: string[]): void {
    const consoleOutput = consoleMessages
        .filter((message) => !message.includes('AppSyncStore connect failed (non-fatal): TypeError: Failed to fetch'))
        .filter((message) => !(message.includes('AppSyncStore fetchSession failed') && message.includes('TypeError: Failed to fetch')))
        .filter((message) => !message.startsWith('[warning] TypeError: Failed to fetch'))
        .join('\n');
    expect(consoleOutput).not.toContain('Buffer is not defined');
    expect(consoleOutput).not.toContain('AppSyncStore fetchSession failed');
    expect(consoleOutput).not.toContain('AppSyncStore connect failed');
    expect(pageErrors).toHaveLength(0);
}

async function closeRecordedBrowserPage(opts: {
    browser: Browser;
    context: BrowserContext;
    page: Page;
}): Promise<string | null> {
    const video = opts.page.video();
    await opts.context.close();
    await opts.browser.close();
    return video ? video.path() : null;
}

describe('Level 3: Browser e2e', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let webServer: ReturnType<typeof startWebAppServer> | null = null;

    beforeAll(async () => {
        await bootTestInfrastructure();

        keyMaterial = makeKeyMaterial();
        node = new SyncNode(getServerUrl(), makeAccountToken(), keyMaterial, {
            resolveSessionKeyMaterial,
        });
        await node.connect();

        webServer = startWebAppServer(getServerUrl());
        try {
            await waitForCondition(
                () => webServer?.getLog().includes(`Waiting on http://localhost:${WEB_PORT}`) ?? false,
                30000,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
            await waitForWebAppReady(WEB_URL, 300000);
        } catch (error) {
            throw new Error(
                `Failed to boot web app.\n` +
                `Web log:\n${webServer.getLog()}\n` +
                `Original error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }, 420000);

    afterAll(async () => {
        node?.disconnect();

        if (webServer?.process && !webServer.process.killed) {
            webServer.process.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                webServer?.process.once('exit', () => resolve());
                setTimeout(resolve, 5000);
            });
        }

        await teardownTestInfrastructure();
    });

    async function runBrowserSmoke(opts: {
        agent: 'claude' | 'codex';
        prompt: string;
    }): Promise<void> {
        const projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: opts.agent,
        }) as SessionID;

        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = getAssistantMessages(node, sessionId).length;
        await node.sendMessage(
            sessionId,
            makeUserMessage(
                `${opts.agent}-browser-smoke`,
                sessionId,
                opts.prompt,
                opts.agent,
                opts.agent === 'claude' ? CLAUDE_MODEL : CODEX_MODEL,
            ),
        );

        await waitForCondition(() => {
            const newMessages = getAssistantMessages(node, sessionId).slice(before);
            if (newMessages.length === 0) {
                return false;
            }

            const toolParts = newMessages.flatMap(getToolParts);
            const textParts = newMessages.flatMap(getTextParts);
            return (
                toolParts.some((tool) => tool.state.status === 'completed')
                && textParts.length > 0
            );
        }, STEP_TIMEOUT);
        const assistantMessages = getAssistantMessages(node, sessionId).slice(before);
        const transcriptSnippet = getBrowserTranscriptSnippet(assistantMessages);
        expect(transcriptSnippet).toBeTruthy();

        const {
            browser,
            context,
            page,
            consoleMessages,
            pageErrors,
        } = await createRecordedBrowserPage({
            viewport: { width: 1440, height: 1400 },
        });

        try {
            const screenshotPath = join(tmpdir(), `happy-browser-${opts.agent}-${Date.now()}.png`);
            const sessionUrl = makeAuthenticatedUrl(`/session/${sessionId}`);

            await gotoHydratedPage(page, sessionUrl, [opts.prompt, 'Completed'], 120000);

            await page.screenshot({ path: screenshotPath, fullPage: true });

            const body = await readBodyText(page);
            const normalizedBody = normalizeVisibleText(body);

            expect(body).toContain(opts.prompt);
            expect(body).toContain('Completed');
            expect(normalizedBody).toContain(transcriptSnippet!);
            expect(body).not.toMatch(/tool_use_id|parent_tool_use_id|call_id|exec_command_begin|exec_command_end|patch_apply_begin|patch_apply_end/);
            assertNoCriticalBrowserErrors(consoleMessages, pageErrors);

            const screenshotStats = await stat(screenshotPath);
            expect(screenshotStats.size).toBeGreaterThan(0);
        } finally {
            await closeRecordedBrowserPage({ browser, context, page });
        }
    }

    it('Claude session transcript renders in the browser', async () => {
        await runBrowserSmoke({
            agent: 'claude',
            prompt: 'Read all files, tell me what this does.',
        });
    }, 300000);

    it('Codex session transcript renders in the browser', async () => {
        await runBrowserSmoke({
            agent: 'codex',
            prompt: 'Read all files, tell me what this does.',
        });
    }, 300000);

    it('Claude browser walkthrough: session list, multi-session, and navigation render correctly', async () => {
        const projectADir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const projectBDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const sessionA = await spawnSessionViaDaemon({
            directory: projectADir,
            agent: 'claude',
        }) as SessionID;
        const sessionB = await spawnSessionViaDaemon({
            directory: projectBDir,
            agent: 'claude',
        }) as SessionID;

        await waitForCondition(
            () => node.state.sessions.has(sessionA as string) && node.state.sessions.has(sessionB as string),
            30000,
        );

        const prompt1 = 'Read all files, tell me what this does.';
        const prompt2 = "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line.";
        const prompt3 = 'Fix it.';

        const before1 = getAssistantMessages(node, sessionA).length;
        await node.sendMessage(sessionA, makeUserMessage(
            'browser-session-a-step1',
            sessionA,
            prompt1,
            'claude',
            CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, sessionA, before1, STEP_TIMEOUT);
        await waitForCondition(() => {
            const tools = getAssistantMessages(node, sessionA).slice(before1).flatMap(getToolParts);
            return tools.length > 0 && tools.every(
                (tool) => tool.state.status === 'completed' || tool.state.status === 'error',
            );
        }, STEP_TIMEOUT);

        const before2 = getAssistantMessages(node, sessionA).length;
        await node.sendMessage(sessionA, makeUserMessage(
            'browser-session-a-step2',
            sessionA,
            prompt2,
            'claude',
            CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, sessionA, before2, STEP_TIMEOUT);

        const before3 = getAssistantMessages(node, sessionA).length;
        await node.sendMessage(sessionA, makeUserMessage(
            'browser-session-a-step3',
            sessionA,
            prompt3,
            'claude',
            CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, sessionA, before3, STEP_TIMEOUT);

        const sessionBProjectName = basename(projectBDir);
        const {
            browser,
            context,
            page,
            consoleMessages,
            pageErrors,
        } = await createRecordedBrowserPage({
            viewport: { width: 1440, height: 2000 },
        });
        let videoPath: string | null = null;

        try {
            const homeUrl = makeAuthenticatedUrl('/');
            const sessionAUrl = makeAuthenticatedUrl(`/session/${sessionA}`);
            const sessionBUrl = makeAuthenticatedUrl(`/session/${sessionB}`);

            const homeBody = await gotoHydratedPage(page, homeUrl, [
                'connected',
                'Start New Session',
                sessionBProjectName,
            ], 120000);
            expect(homeBody).toContain(sessionBProjectName);
            expect(homeBody).not.toContain('No active sessions');

            const sessionABody = await gotoHydratedPage(page, sessionAUrl, [prompt1, prompt2, prompt3, 'Completed'], 120000);
            expect(sessionABody).toContain(prompt1);
            expect(sessionABody).toContain(prompt2);
            expect(sessionABody).toContain(prompt3);
            expect(sessionABody).toMatch(/index\.html|styles\.css|app\.js|ux-spec\.md|exercise-flow\.md/);
            expect((sessionABody.match(/\bCompleted\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
            expect(sessionABody).not.toMatch(/tool_use_id|parent_tool_use_id|call_id/);
            expect(sessionABody).not.toMatch(/exec_command_begin|exec_command_end|patch_apply_begin|patch_apply_end/);
            expect(sessionABody).not.toMatch(/"type"\s*:\s*"tool_use"/);
            expect(sessionABody).not.toMatch(/"type"\s*:\s*"content_block"/);

            const prompt1Pos = sessionABody.indexOf(prompt1);
            const prompt2Pos = sessionABody.indexOf(prompt2);
            const prompt3Pos = sessionABody.indexOf(prompt3);
            expect(prompt1Pos).toBeGreaterThan(-1);
            expect(prompt2Pos).toBeGreaterThan(prompt1Pos);
            expect(prompt3Pos).toBeGreaterThan(prompt2Pos);

            const sessionABodyLength = sessionABody.length;

            const sessionBBody = await gotoHydratedPage(page, sessionBUrl, ['No messages yet'], 120000);
            expect(sessionBBody).toContain(sessionBProjectName);
            expect(sessionBBody).toContain('Created');
            expect(sessionBBody).not.toContain(prompt1);
            expect(sessionBBody).not.toContain(prompt2);
            expect(sessionBBody).not.toContain(prompt3);
            const sessionBPlaceholder = await page.locator('textarea').first().getAttribute('placeholder');
            expect(sessionBPlaceholder ?? '').toContain('Type a message');

            await gotoHydratedPage(page, homeUrl, ['connected', 'Start New Session'], 120000);

            const sessionABodyAfterReturn = await gotoHydratedPage(
                page,
                sessionAUrl,
                [prompt1, prompt2, prompt3, 'Completed'],
                120000,
            );
            expect(sessionABodyAfterReturn.length).toBe(sessionABodyLength);

            assertNoCriticalBrowserErrors(consoleMessages, pageErrors);
        } finally {
            videoPath = await closeRecordedBrowserPage({ browser, context, page });
        }

        expect(videoPath).not.toBeNull();
        if (videoPath) {
            const videoStats = await stat(videoPath);
            expect(videoStats.size).toBeGreaterThan(0);
        }
    }, 600000);

    it('Tab close/reopen preserves transcript, and completed session still renders', async () => {
        const projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
        }) as SessionID;

        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const prompt = 'Read all files, tell me what this does.';
        const before = getAssistantMessages(node, sessionId).length;
        await node.sendMessage(
            sessionId,
            makeUserMessage('tab-reopen', sessionId, prompt, 'claude', CLAUDE_MODEL),
        );
        await waitForStepFinish(node, sessionId, before, STEP_TIMEOUT);
        await waitForCondition(() => {
            const tools = getAssistantMessages(node, sessionId).slice(before).flatMap(getToolParts);
            return tools.length > 0 && tools.every(
                (tool) => tool.state.status === 'completed' || tool.state.status === 'error',
            );
        }, STEP_TIMEOUT);

        const sessionUrl = makeAuthenticatedUrl(`/session/${sessionId}`);

        // --- Part 1: open session, verify, close tab, reopen ---
        const browser1 = await createRecordedBrowserPage({ viewport: { width: 1440, height: 1400 } });
        let body1: string;
        try {
            body1 = await gotoHydratedPage(browser1.page, sessionUrl, [prompt, 'Completed'], 120000);
            expect(body1).toContain(prompt);
            expect(body1).toContain('Completed');
            assertNoCriticalBrowserErrors(browser1.consoleMessages, browser1.pageErrors);
        } finally {
            await closeRecordedBrowserPage(browser1);
        }

        // Simulate tab close/reopen: new browser context, same URL
        const browser2 = await createRecordedBrowserPage({ viewport: { width: 1440, height: 1400 } });
        try {
            const body2 = await gotoHydratedPage(browser2.page, sessionUrl, [prompt, 'Completed'], 120000);
            expect(body2).toContain(prompt);
            expect(body2).toContain('Completed');
            // Transcript length should be the same (no content lost)
            expect(body2.length).toBe(body1!.length);
            assertNoCriticalBrowserErrors(browser2.consoleMessages, browser2.pageErrors);
        } finally {
            await closeRecordedBrowserPage(browser2);
        }

        // --- Part 2: stop the session, then reopen in browser ---
        await node.stopSession(sessionId);
        await waitForCondition(() => {
            const session = node.state.sessions.get(sessionId as string);
            return session?.status?.type === 'completed';
        }, 15000);

        const browser3 = await createRecordedBrowserPage({ viewport: { width: 1440, height: 1400 } });
        try {
            const body3 = await gotoHydratedPage(browser3.page, sessionUrl, [prompt, 'Completed'], 120000);
            expect(body3).toContain(prompt);
            expect(body3).toContain('Completed');
            expect(body3).not.toMatch(/tool_use_id|parent_tool_use_id|call_id/);
            assertNoCriticalBrowserErrors(browser3.consoleMessages, browser3.pageErrors);

            const screenshotPath = join(tmpdir(), `happy-browser-completed-session-${Date.now()}.png`);
            await browser3.page.screenshot({ path: screenshotPath, fullPage: true });
            const screenshotStats = await stat(screenshotPath);
            expect(screenshotStats.size).toBeGreaterThan(0);
        } finally {
            await closeRecordedBrowserPage(browser3);
        }
    }, 600000);

    it('Session B updates do not rerender the open Session A transcript', async () => {
        const projectADir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const projectBDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const sessionA = await spawnSessionViaDaemon({
            directory: projectADir,
            agent: 'claude',
        }) as SessionID;
        const sessionB = await spawnSessionViaDaemon({
            directory: projectBDir,
            agent: 'claude',
        }) as SessionID;

        await waitForCondition(
            () => node.state.sessions.has(sessionA as string) && node.state.sessions.has(sessionB as string),
            30000,
        );

        const promptA = 'Read all files, tell me what this does.';
        const beforeA = getAssistantMessages(node, sessionA).length;
        await node.sendMessage(sessionA, makeUserMessage(
            'rerender-a',
            sessionA,
            promptA,
            'claude',
            CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, sessionA, beforeA, 120000);

        const {
            browser,
            context,
            page,
            consoleMessages,
            pageErrors,
        } = await createRecordedBrowserPage({
            viewport: { width: 1440, height: 1600 },
        });

        try {
            const sessionUrl = makeAuthenticatedUrl(`/session/${sessionA}`);
            await gotoHydratedPage(page, sessionUrl, [promptA, 'Completed'], 120000);

            await page.waitForTimeout(1500);
            await page.evaluate((sessionId: string) => {
                const target = globalThis as typeof globalThis & {
                    __HAPPY_TRANSCRIPT_RENDER_COUNTS__?: Record<string, number>;
                };
                target.__HAPPY_TRANSCRIPT_RENDER_COUNTS__ ??= {};
                target.__HAPPY_TRANSCRIPT_RENDER_COUNTS__[sessionId] = 0;
            }, sessionA as string);
            await page.waitForTimeout(1500);

            const promptB = 'Reply with the single word "pong".';
            const beforeB = getAssistantMessages(node, sessionB).length;
            await node.sendMessage(sessionB, makeUserMessage(
                'rerender-b',
                sessionB,
                promptB,
                'claude',
                CLAUDE_MODEL,
            ));
            await waitForCondition(
                () => getAssistantMessages(node, sessionB).length > beforeB,
                60000,
            );
            await page.waitForTimeout(3000);

            const renderCountA = await page.evaluate((sessionId: string) => {
                const target = globalThis as typeof globalThis & {
                    __HAPPY_TRANSCRIPT_RENDER_COUNTS__?: Record<string, number>;
                };
                return target.__HAPPY_TRANSCRIPT_RENDER_COUNTS__?.[sessionId] ?? 0;
            }, sessionA as string);
            const body = await readBodyText(page);

            expect(renderCountA).toBe(0);
            expect(body).toContain(promptA);
            expect(body).not.toContain(promptB);
            assertNoCriticalBrowserErrors(consoleMessages, pageErrors);
        } finally {
            await closeRecordedBrowserPage({ browser, context, page });
        }
    }, 300000);
});
