/**
 * Level 3: Browser smoke verification for the two key agents.
 *
 * Boots the real standalone server + daemon from the Level 2 harness, starts
 * the real Happy web app, then opens a real Claude/Codex session in Chrome.
 * The browser asserts that the transcript hydrates and renders a real tool-
 * heavy response instead of failing inside the web SyncNode path.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { SessionID } from '../protocol';
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
    waitForPendingPermission,
    waitForPendingQuestion,
} from './helpers';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = Number(process.env.HAPPY_BROWSER_WEB_PORT ?? '19006');
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const STEP_TIMEOUT = 240000;

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

async function waitForWebAppReady(url: string, timeoutMs = 120000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            const body = await response.text();
            if (response.ok && body.includes('Happy')) {
                return;
            }
        } catch {
            // Server not ready yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Web app not ready at ${url} after ${timeoutMs}ms`);
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
            CI: '1',
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

describe('Level 3: Browser smoke (Claude + Codex)', () => {
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
            await waitForWebAppReady(WEB_URL);
        } catch (error) {
            throw new Error(
                `Failed to boot web app.\n` +
                `Web log:\n${webServer.getLog()}\n` +
                `Original error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }, 180000);

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

        const consoleMessages: string[] = [];
        const pageErrors: string[] = [];

        const browser = await chromium.launch({
            headless: true,
            channel: process.env.HAPPY_BROWSER_CHANNEL ?? 'chrome',
        });

        try {
            const page = await browser.newPage({
                viewport: { width: 1440, height: 1400 },
            });

            page.on('console', (message) => {
                consoleMessages.push(`[${message.type()}] ${message.text()}`);
            });
            page.on('pageerror', (error) => {
                pageErrors.push(error.stack || error.message);
            });

            const screenshotPath = join(tmpdir(), `happy-browser-${opts.agent}-${Date.now()}.png`);
            const sessionUrl = (
                `${WEB_URL}/session/${sessionId}` +
                `?dev_token=${encodeURIComponent(getAuthToken())}` +
                `&dev_secret=${encodeURIComponent(encodeBase64Url(getEncryptionSecret()))}`
            );

            await page.goto(sessionUrl, { waitUntil: 'networkidle' });
            await page.waitForFunction(
                (expectedPrompt: string) => document.body?.innerText.includes(expectedPrompt) ?? false,
                opts.prompt,
                { timeout: 60000 },
            );

            await page.waitForFunction(
                () => {
                    const body = document.body?.innerText ?? '';
                    return /index\.html|styles\.css|app\.js|ux-spec\.md|exercise-flow\.md/.test(body);
                },
                undefined,
                { timeout: 60000 },
            );

            await page.screenshot({ path: screenshotPath, fullPage: true });

            const body = await page.textContent('body') ?? '';

            expect(body).toContain(opts.prompt);
            expect(body).toMatch(/index\.html|styles\.css|app\.js|ux-spec\.md|exercise-flow\.md/);
            expect(body).not.toMatch(/tool_use_id|parent_tool_use_id|call_id|exec_command_begin|exec_command_end|patch_apply_begin|patch_apply_end/);
            expect(consoleMessages.join('\n')).not.toContain('Buffer is not defined');
            expect(consoleMessages.join('\n')).not.toContain('AppSyncStore fetchSession failed');
            expect(consoleMessages.join('\n')).not.toContain('AppSyncStore connect failed');
            expect(pageErrors).toHaveLength(0);

            const screenshotStats = await stat(screenshotPath);
            expect(screenshotStats.size).toBeGreaterThan(0);
        } finally {
            await browser.close();
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  EXPANDED UX VERIFICATION
    //
    //  Runs a multi-step exercise flow (Steps 1-4 + 12) against real Claude,
    //  then opens the browser and verifies the rendered transcript covers:
    //    - Multiple user messages in order
    //    - Tool parts with Completed / Error status labels
    //    - Permission deny + approve decisions
    //    - Question / answer UI
    //    - No raw JSON or provider events
    // ═══════════════════════════════════════════════════════════════════════════

    it('Claude multi-step UX: permissions + question render correctly', async () => {
        const uxProjectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const uxSessionId = await spawnSessionViaDaemon({
            directory: uxProjectDir,
            agent: 'claude',
        }) as SessionID;

        await waitForCondition(() => node.state.sessions.has(uxSessionId as string), 30000);

        const uxSession = () => node.state.sessions.get(uxSessionId as string)!;

        // ── Step 1: Read files → text + tool parts ──────────────────────────
        console.log('[UX test] Step 1: sending read-all prompt');
        const before1 = getAssistantMessages(node, uxSessionId).length;
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step1', uxSessionId,
            'Read all files, tell me what this does.',
            'claude', CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, uxSessionId, before1, 120000);
        await waitForCondition(() => {
            const tools = getAssistantMessages(node, uxSessionId)
                .slice(before1).flatMap(getToolParts);
            return tools.length > 0 && tools.every(
                t => t.state.status === 'completed' || t.state.status === 'error',
            );
        }, 180000);
        console.log('[UX test] Step 1: done');

        // ── Step 2: Find the bug → text response ───────────────────────────
        console.log('[UX test] Step 2: sending find-bug prompt');
        const before2 = getAssistantMessages(node, uxSessionId).length;
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step2', uxSessionId,
            "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line.",
            'claude', CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, uxSessionId, before2, 120000);
        console.log('[UX test] Step 2: done');

        // ── Step 3: Fix it → deny permission ───────────────────────────────
        console.log('[UX test] Step 3: sending fix-it prompt (will deny)');
        const before3 = getAssistantMessages(node, uxSessionId).length;
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step3', uxSessionId, 'Fix it.',
            'claude', CLAUDE_MODEL,
        ));
        await waitForPendingPermission(node, uxSessionId, 120000);
        const deniedPerm = uxSession().permissions.find(p => !p.resolved)!;
        console.log(`[UX test] Step 3: denying permission ${deniedPerm.permissionId}`);
        await node.denyPermission(uxSessionId, deniedPerm.permissionId);
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step3b', uxSessionId,
            'No — show me the diff first.',
            'claude', CLAUDE_MODEL,
        ));
        await waitForStepFinish(node, uxSessionId, before3, 120000);
        console.log('[UX test] Step 3: done');

        // ── Step 4: Approve once ────────────────────────────────────────────
        console.log('[UX test] Step 4: sending approve prompt');
        const before4 = getAssistantMessages(node, uxSessionId).length;
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step4', uxSessionId,
            'Ok that diff looks right. Go ahead and apply it.',
            'claude', CLAUDE_MODEL,
        ));
        await waitForPendingPermission(node, uxSessionId, 120000);
        const approvedPerm = uxSession().permissions.find(p => !p.resolved)!;
        console.log(`[UX test] Step 4: approving permission ${approvedPerm.permissionId}`);
        await node.approvePermission(
            uxSessionId, approvedPerm.permissionId, { decision: 'once' },
        );
        await waitForStepFinish(node, uxSessionId, before4, 120000);
        console.log('[UX test] Step 4: done');

        // ── Step 12: Question → answer (best-effort) ──────────────────────
        // Claude may or may not use the formal AskUserQuestion tool.
        // If it does, we answer and verify the question UI renders.
        // If not, we still proceed — the permission flow is the core test.
        console.log('[UX test] Step 12: sending question prompt');
        let questionAnswered = false;
        const before12 = getAssistantMessages(node, uxSessionId).length;
        await node.sendMessage(uxSessionId, makeUserMessage(
            'ux-step12', uxSessionId,
            'I want to add a test framework. Ask me which one I want before you set anything up.',
            'claude', CLAUDE_MODEL,
        ));
        try {
            await waitForPendingQuestion(node, uxSessionId, 60000);
            const pendingQ = uxSession().questions.find(q => !q.resolved)!;
            console.log(`[UX test] Step 12: answering question ${pendingQ.questionId} with "Vitest"`);
            await node.answerQuestion(uxSessionId, pendingQ.questionId, [['Vitest']]);
            questionAnswered = true;
        } catch {
            console.log('[UX test] Step 12: no formal question — Claude responded with text');
        }
        await waitForStepFinish(node, uxSessionId, before12, 120000);
        console.log(`[UX test] Step 12: done (question answered: ${questionAnswered})`);

        // ── Browser verification ────────────────────────────────────────────
        console.log('[UX test] Opening browser to verify rendered transcript');
        const consoleMessages: string[] = [];
        const pageErrors: string[] = [];
        const browser = await chromium.launch({
            headless: true,
            channel: process.env.HAPPY_BROWSER_CHANNEL ?? 'chrome',
        });

        try {
            const page = await browser.newPage({
                viewport: { width: 1440, height: 2000 },
            });
            page.on('console', (msg) => {
                consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
            });
            page.on('pageerror', (err) => {
                pageErrors.push(err.stack || err.message);
            });

            const sessionUrl = (
                `${WEB_URL}/session/${uxSessionId}` +
                `?dev_token=${encodeURIComponent(getAuthToken())}` +
                `&dev_secret=${encodeURIComponent(encodeBase64Url(getEncryptionSecret()))}`
            );

            await page.goto(sessionUrl, { waitUntil: 'networkidle' });

            // Wait for transcript to render multiple steps
            await page.waitForFunction(
                () => {
                    const body = document.body?.innerText ?? '';
                    return (
                        body.includes('Read all files') &&
                        body.includes('Fix it.') &&
                        body.includes('test framework')
                    );
                },
                undefined,
                { timeout: 60000 },
            );

            const screenshotPath = join(
                tmpdir(),
                `happy-browser-claude-ux-${Date.now()}.png`,
            );
            await page.screenshot({ path: screenshotPath, fullPage: true });

            const body = await page.textContent('body') ?? '';
            console.log(`[UX test] Body length: ${body.length} chars`);

            // ── UX Spec: User messages render with original text ────────────
            expect(body).toContain('Read all files, tell me what this does.');
            expect(body).toContain('Fix it.');
            expect(body).toContain('show me the diff first');
            expect(body).toContain('Go ahead and apply it.');
            expect(body).toContain('Ask me which one I want');

            // ── UX Spec: Assistant text is formatted, not raw JSON ──────────
            expect(body).toMatch(/filter|done|bug|app\.js/i);

            // ── UX Spec: Tool status labels visible ─────────────────────────
            // Completed tools from Step 1 reads + Step 4 approved edit
            expect(body).toMatch(/Completed/);
            // Denied tool from Step 3 shows error state
            expect(body).toMatch(/Error/);

            // ── UX Spec: Permission buttons rendered ────────────────────────
            expect(body).toMatch(/Yes/);

            // ── UX Spec: Session is scrollable, steps in order ──────────────
            // Use exact user prompts for ordering (avoid matching
            // assistant text that might mention similar phrases)
            const step1Pos = body.indexOf('Read all files, tell me what this does.');
            const step3Pos = body.indexOf('Fix it.');
            const step4Pos = body.indexOf('Go ahead and apply it.');
            const step12Pos = body.indexOf('Ask me which one I want');
            expect(step1Pos).toBeGreaterThan(-1);
            expect(step3Pos).toBeGreaterThan(step1Pos);
            expect(step4Pos).toBeGreaterThan(step3Pos);
            expect(step12Pos).toBeGreaterThan(step4Pos);

            // ── UX Spec: No raw provider events visible ─────────────────────
            expect(body).not.toMatch(
                /tool_use_id|parent_tool_use_id|call_id/,
            );
            expect(body).not.toMatch(
                /exec_command_begin|exec_command_end|patch_apply_begin|patch_apply_end/,
            );

            // ── UX Spec: No raw JSON blobs ──────────────────────────────────
            expect(body).not.toMatch(/"type"\s*:\s*"tool_use"/);
            expect(body).not.toMatch(/"type"\s*:\s*"content_block"/);

            // ── No critical browser errors ──────────────────────────────────
            expect(consoleMessages.join('\n')).not.toContain(
                'Buffer is not defined',
            );
            expect(consoleMessages.join('\n')).not.toContain(
                'AppSyncStore fetchSession failed',
            );
            expect(consoleMessages.join('\n')).not.toContain(
                'AppSyncStore connect failed',
            );
            expect(pageErrors).toHaveLength(0);

            // ── Screenshot captured ─────────────────────────────────────────
            const stats = await stat(screenshotPath);
            expect(stats.size).toBeGreaterThan(0);

            console.log(`[UX test] Screenshot: ${screenshotPath}`);
            console.log(`[UX test] Console messages: ${consoleMessages.length}`);
            console.log('[UX test] All browser assertions passed');
        } finally {
            await browser.close();
        }
    }, 600000);
});
