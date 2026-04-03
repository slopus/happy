#!/usr/bin/env npx tsx
/**
 * Phase 1 UX Review — Full 38-step visual walkthrough with Playwright video.
 *
 * Boots full e2e stack, spawns a real Claude session, runs all 38 exercise steps,
 * and records the entire browser session on video. Takes screenshots at each step.
 *
 * Saves to e2e-recordings/ux-review/:
 *   - walkthrough.webm — continuous video of the entire session
 *   - step-NN-name.png — screenshot after each step
 *   - home.png — session list
 *
 * Usage:
 *   npx tsx packages/happy-sync/src/e2e/phase1-ux-review.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { SyncNode } from '../sync-node';
import type { MessageWithParts, SessionID, Part } from '../v3-compat';
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
    getToolParts,
    getTextParts,
    getFullText,
    hasPart,
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    resolveSessionKeyMaterial,
    waitForCondition,
} from './helpers';

// ─── Config ──────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = 19018;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const OUTPUT_DIR = join(REPO_ROOT, 'e2e-recordings', 'ux-review');
const STEP_TIMEOUT = 300000; // 5 min per step

// ─── Exercise Steps ──────────────────────────────────────────────────────────

interface ExerciseStep {
    id: number;
    name: string;
    prompt: string;
    action: 'send' | 'cancel' | 'stop' | 'reopen' | 'resume';
    timeoutMs: number;
    permissionAction: 'auto' | 'deny-first' | 'none';
    newSession?: boolean;
}

const STEPS: ExerciseStep[] = [
    { id: 0, name: 'Open the agent', prompt: '', action: 'send', timeoutMs: 0, permissionAction: 'none' },
    { id: 1, name: 'Orient', prompt: 'Read all the files in this project and tell me what it does. Be thorough.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 2, name: 'Find the bug', prompt: "There's a bug in the Done filter — it doesn't work. Find it and explain what's wrong, but don't fix it yet.", action: 'send', timeoutMs: 60000, permissionAction: 'none' },
    { id: 3, name: 'Edit rejected', prompt: 'Fix it.', action: 'send', timeoutMs: 120000, permissionAction: 'deny-first' },
    { id: 4, name: 'Edit approved once', prompt: 'Ok apply the fix.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 5, name: 'Edit approved always', prompt: 'Add a dark mode toggle to the app. Add a button in the header that switches between light and dark themes.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 6, name: 'Auto-approved edit', prompt: 'The dark mode looks good. Now add a responsive layout — make the app look good on mobile. Touch all three files (HTML, CSS, JS) if needed.', action: 'send', timeoutMs: 90000, permissionAction: 'auto' },
    { id: 7, name: 'Search the web', prompt: 'Search the web for best practices on accessible keyboard shortcuts for todo apps. Summarize what you find.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 8, name: 'Parallel explore', prompt: "I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.", action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 9, name: 'Simple edit', prompt: 'Based on what the subagents found, add Cmd+Enter as a shortcut to submit the todo form.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 10, name: 'Cancel', prompt: 'Actually, also add Escape to clear the form, Tab navigation between todos, and Delete to remove the selected todo.', action: 'cancel', timeoutMs: 10000, permissionAction: 'none' },
    { id: 11, name: 'Resume after cancel', prompt: 'Tell me what keyboard shortcuts are currently set up in the app.', action: 'send', timeoutMs: 30000, permissionAction: 'auto', newSession: true },
    { id: 12, name: 'Agent asks question', prompt: 'Set up a testing framework for this project. Ask me which one I want before you start.', action: 'send', timeoutMs: 30000, permissionAction: 'none' },
    { id: 13, name: 'Act on the answer', prompt: '', action: 'send', timeoutMs: 270000, permissionAction: 'auto' }, // Answer: Vitest
    { id: 14, name: 'Read outside project', prompt: 'List the files in the parent directory (one level up from this project).', action: 'send', timeoutMs: 30000, permissionAction: 'auto' },
    { id: 15, name: 'Write outside project', prompt: 'Create a file called ../outside-test.txt with the content "hello from outside".', action: 'send', timeoutMs: 30000, permissionAction: 'auto' },
    { id: 16, name: 'Create todos', prompt: 'Create a todo list for the remaining improvements we should make to this app. Include at least 3 items.', action: 'send', timeoutMs: 30000, permissionAction: 'auto' },
    { id: 17, name: 'Switch and edit', prompt: 'Pick the most impactful todo item and implement it.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 18, name: 'Compact', prompt: 'Compact the context.', action: 'send', timeoutMs: 30000, permissionAction: 'none' },
    { id: 19, name: 'Post-compaction sanity', prompt: 'What files have we changed so far?', action: 'send', timeoutMs: 30000, permissionAction: 'auto' },
    { id: 20, name: 'Close', prompt: '', action: 'stop', timeoutMs: 0, permissionAction: 'none' },
    { id: 21, name: 'Reopen', prompt: '', action: 'reopen', timeoutMs: 5000, permissionAction: 'none', newSession: true },
    { id: 22, name: 'Verify continuity', prompt: "What's the current state of this project? Have any changes been made?", action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 23, name: 'Mark todo done', prompt: 'Mark the todo we just completed as done.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 25, name: 'Multiple permissions', prompt: 'Refactor the app: extract the filter logic into a separate filters.js file and the theme logic into theme.js. Update imports in app.js.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 26, name: 'Supersede pending', prompt: "Actually, undo that refactor. Put everything back in app.js — it's simpler as one file for this project.", action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 27, name: 'Subagent permission wall', prompt: "Use a subagent to add a 'clear completed' button. The subagent should edit index.html and app.js.", action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 28, name: 'Stop while pending', prompt: 'Now add a button to export todos as JSON. Put it next to the clear completed button.', action: 'cancel', timeoutMs: 30000, permissionAction: 'none' },
    { id: 29, name: 'Resume after forced stop', prompt: 'What happened with the priority feature we were working on?', action: 'resume', timeoutMs: 120000, permissionAction: 'auto', newSession: true },
    { id: 30, name: 'Retry after stop', prompt: 'Try again — add the priority field. Approve everything this time.', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 31, name: 'Launch background task', prompt: 'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 32, name: 'Background completes', prompt: 'Did that background task finish? What was the output?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 33, name: 'Interact during background', prompt: 'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 34, name: 'Full summary (part 1)', prompt: 'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 35, name: 'Background subagent (TaskCreate)', prompt: "Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works.", action: 'send', timeoutMs: STEP_TIMEOUT, permissionAction: 'auto' },
    { id: 36, name: 'Check background result (TaskOutput)', prompt: 'Did that background research finish? What did it find?', action: 'send', timeoutMs: STEP_TIMEOUT, permissionAction: 'auto' },
    { id: 37, name: 'Multiple background tasks', prompt: 'Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".', action: 'send', timeoutMs: STEP_TIMEOUT, permissionAction: 'auto' },
    { id: 38, name: 'Final summary', prompt: 'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${msg}`);
}

function encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function makeAuthenticatedUrl(pathname: string): string {
    return (
        `${WEB_URL}${pathname}` +
        `?dev_token=${encodeURIComponent(getAuthToken())}` +
        `&dev_secret=${encodeURIComponent(encodeBase64Url(getEncryptionSecret()))}`
    );
}

function hasTerminalStepFinish(message: MessageWithParts): boolean {
    return message.parts.some(
        (part) => part.type === 'step-finish' && part.reason !== 'tool-calls',
    );
}

function startWebAppServer(serverUrl: string): {
    process: ChildProcess;
    getLog: () => string;
} {
    let logBuffer = '';
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
    child.stdout?.on('data', (chunk) => { logBuffer += String(chunk); });
    child.stderr?.on('data', (chunk) => { logBuffer += String(chunk); });
    return { process: child, getLog: () => logBuffer };
}

async function waitForWebAppReady(url: string, timeoutMs = 300000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            const body = await response.text();
            if (response.ok && body.includes('Happy')) {
                const bundlePath = body.match(/<script[^>]+src="([^"]+\.bundle[^"]*)"[^>]*><\/script>/i)?.[1];
                if (bundlePath) {
                    const bundleUrl = new URL(bundlePath, url).toString();
                    const remaining = Math.max(timeoutMs - (Date.now() - start), 1000);
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), remaining);
                    try {
                        const bundleResponse = await fetch(bundleUrl, { signal: controller.signal });
                        if (bundleResponse.ok) {
                            bundleResponse.body?.cancel().catch(() => {});
                            return;
                        }
                    } finally {
                        clearTimeout(timer);
                    }
                }
            }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Web app not ready at ${url} after ${timeoutMs}ms`);
}

async function waitForBodyText(page: Page, texts: string[], timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const body = await page.evaluate(() => {
            const b = (globalThis as any).document?.body;
            return b?.innerText ?? '';
        });
        if (texts.every((t) => body.includes(t))) return body;
        await page.waitForTimeout(500);
    }
    throw new Error(`Body text not found: ${texts.join(', ')}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const results: Array<{ step: number; name: string; status: string; duration: number; tools: string[] }> = [];
    let webServer: ReturnType<typeof startWebAppServer> | null = null;
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
        // ── 1. Boot infrastructure ────────────────────────────────────────
        log('Booting test infrastructure (PGlite server + daemon)...');
        await bootTestInfrastructure();
        const projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        const keyMaterial = makeKeyMaterial();
        const node = new SyncNode(getServerUrl(), makeAccountToken(), keyMaterial, {
            resolveSessionKeyMaterial,
        });
        await node.connect();
        log(`Infrastructure ready. Server: ${getServerUrl()}`);

        // ── 2. Start Expo web ─────────────────────────────────────────────
        log('Starting Expo web dev server...');
        webServer = startWebAppServer(getServerUrl());
        await waitForWebAppReady(WEB_URL);
        log(`Web app ready at ${WEB_URL}`);

        // ── 3. Launch Playwright with video ───────────────────────────────
        log('Launching Playwright browser with video recording...');
        browser = await chromium.launch({
            headless: true,
            channel: process.env.HAPPY_BROWSER_CHANNEL ?? 'chrome',
        });
        context = await browser.newContext({
            viewport: { width: 1440, height: 1080 },
            recordVideo: { dir: OUTPUT_DIR, size: { width: 1440, height: 1080 } },
        });
        page = await context.newPage();
        log('Browser ready with video recording.');

        // ── 4. Spawn Claude session ───────────────────────────────────────
        let sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);
        log(`Session spawned: ${sessionId}`);

        // Navigate to session page
        const sessionUrl = makeAuthenticatedUrl(`/session/${sessionId}`);
        await page.goto(sessionUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000); // Let the app hydrate
        await page.screenshot({ path: join(OUTPUT_DIR, 'step-00-open.png'), fullPage: false });
        log('Step 0: Session page loaded');
        results.push({ step: 0, name: 'Open the agent', status: 'pass', duration: 0, tools: [] });

        // ── 5. Run all exercise steps ─────────────────────────────────────
        const approvedIds = new Set<string>();
        function autoApproveAll() {
            for (const sess of node.state.sessions.values()) {
                for (const perm of sess.permissions) {
                    if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                        approvedIds.add(perm.permissionId);
                        node.approvePermission(sess.info.id, perm.permissionId, { decision: 'once' }).catch(() => {});
                    }
                }
            }
        }

        for (const step of STEPS) {
            if (step.id === 0) continue; // Already handled

            const stepStart = Date.now();
            log(`\n── Step ${step.id}: ${step.name} ──`);

            try {
                if (step.action === 'stop') {
                    await node.stopSession(sessionId);
                    log(`  Session stopped.`);
                    results.push({ step: step.id, name: step.name, status: 'pass', duration: Date.now() - stepStart, tools: [] });
                    // Screenshot of stopped session
                    await page.waitForTimeout(2000);
                    await page.screenshot({ path: join(OUTPUT_DIR, `step-${String(step.id).padStart(2, '0')}-${step.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`), fullPage: false });
                    continue;
                }

                if (step.action === 'reopen' || step.newSession) {
                    if (step.action === 'resume') {
                        const previousSessionId = sessionId;
                        sessionId = await spawnSessionViaDaemon({
                            directory: projectDir,
                            agent: 'claude',
                            sessionId: previousSessionId,
                        }) as SessionID;
                    } else {
                        sessionId = await spawnSessionViaDaemon({
                            directory: projectDir,
                            agent: 'claude',
                        }) as SessionID;
                    }
                    await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);
                    log(`  New session: ${sessionId}`);

                    // Navigate to new session
                    const newUrl = makeAuthenticatedUrl(`/session/${sessionId}`);
                    await page.goto(newUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await page.waitForTimeout(3000);

                    if (step.action === 'reopen' && !step.prompt) {
                        results.push({ step: step.id, name: step.name, status: 'pass', duration: Date.now() - stepStart, tools: [] });
                        await page.screenshot({ path: join(OUTPUT_DIR, `step-${String(step.id).padStart(2, '0')}-${step.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`), fullPage: false });
                        continue;
                    }
                }

                if (step.action === 'cancel') {
                    // Send prompt, wait briefly, then stop
                    const before = getAssistantMessages(node, sessionId).length;
                    await node.sendMessage(sessionId, makeUserMessage(`step${step.id}`, sessionId, step.prompt));
                    await new Promise((r) => setTimeout(r, 3000));
                    await node.stopSession(sessionId);
                    log(`  Sent + cancelled after 3s`);
                    results.push({ step: step.id, name: step.name, status: 'pass', duration: Date.now() - stepStart, tools: [] });
                    await page.waitForTimeout(2000);
                    await page.screenshot({ path: join(OUTPUT_DIR, `step-${String(step.id).padStart(2, '0')}-${step.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`), fullPage: false });
                    continue;
                }

                // Regular send
                const before = getAssistantMessages(node, sessionId).length;

                // Special handling for Step 13 (answer question)
                if (step.id === 13) {
                    // Answer the question from Step 12 first
                    const sess = node.state.sessions.get(sessionId as string)!;
                    const pendingQ = sess.questions?.find((q: any) => !q.resolved);
                    if (pendingQ) {
                        await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);
                        log('  Answered question: Vitest');
                    } else {
                        // Claude may have listed options in text — send "Vitest" as user message
                        await node.sendMessage(sessionId, makeUserMessage('step13', sessionId, 'Vitest'));
                        log('  Sent "Vitest" as user message');
                    }
                } else {
                    await node.sendMessage(sessionId, makeUserMessage(`step${step.id}`, sessionId, step.prompt));
                }

                // Wait for response with auto-approval
                await waitForCondition(() => {
                    if (step.permissionAction === 'auto') autoApproveAll();

                    const msgs = getAssistantMessages(node, sessionId);
                    if (msgs.length <= before) return false;

                    // Check for terminal step-finish
                    for (let i = before; i < msgs.length; i++) {
                        if (hasTerminalStepFinish(msgs[i])) return true;
                    }
                    return false;
                }, step.timeoutMs);

                // Collect tools from this step
                const newMsgs = getAssistantMessages(node, sessionId).slice(before);
                const tools = newMsgs.flatMap(getToolParts).map((t) => `${t.tool}:${t.state.status}`);
                const duration = Date.now() - stepStart;

                log(`  ✅ Passed (${(duration / 1000).toFixed(1)}s) — ${tools.length} tools: ${tools.join(', ') || 'text only'}`);
                results.push({ step: step.id, name: step.name, status: 'pass', duration, tools });

            } catch (error) {
                const duration = Date.now() - stepStart;
                const errMsg = error instanceof Error ? error.message : String(error);
                log(`  ❌ Failed (${(duration / 1000).toFixed(1)}s): ${errMsg.slice(0, 200)}`);
                results.push({ step: step.id, name: step.name, status: `fail: ${errMsg.slice(0, 100)}`, duration, tools: [] });
            }

            // Screenshot after each step — scroll chat container to show latest content
            try {
                await page.waitForTimeout(2000); // Let browser sync
                // The chat uses an inverted FlatList (scaleY(-1) on web). Find the
                // deepest scrollable element (the FlatList container) and scroll it
                // so the latest messages are visible. Because it's inverted,
                // scrollTop=0 shows newest content.
                await page.evaluate(`(() => {
                    const candidates = document.querySelectorAll('div, [role="list"]');
                    let best = null;
                    let bestScrollHeight = 0;
                    for (const el of candidates) {
                        const style = getComputedStyle(el);
                        const isScrollable = style.overflow === 'auto' || style.overflow === 'scroll' ||
                            style.overflowY === 'auto' || style.overflowY === 'scroll';
                        if (isScrollable && el.scrollHeight > el.clientHeight && el.scrollHeight > bestScrollHeight) {
                            best = el;
                            bestScrollHeight = el.scrollHeight;
                        }
                    }
                    if (best) {
                        best.scrollTop = 0;
                    }
                })()`);
                await page.waitForTimeout(500);
                const filename = `step-${String(step.id).padStart(2, '0')}-${step.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.png`;
                await page.screenshot({ path: join(OUTPUT_DIR, filename), fullPage: true });
            } catch {}
        }

        // ── 6. Session list (home page) screenshot ────────────────────────
        try {
            const homeUrl = makeAuthenticatedUrl('/');
            await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            await page.screenshot({ path: join(OUTPUT_DIR, 'home-session-list.png'), fullPage: false });
            log('\nHome page (session list) screenshot taken.');
        } catch (e) {
            log(`Warning: Failed to take home page screenshot: ${e}`);
        }

        // ── 7. Save results ───────────────────────────────────────────────
        const passed = results.filter((r) => r.status === 'pass').length;
        const failed = results.filter((r) => r.status !== 'pass').length;
        log(`\n═══ Results: ${passed} passed, ${failed} failed out of ${results.length} steps ═══`);
        for (const r of results) {
            log(`  Step ${r.step}: ${r.name} — ${r.status} (${(r.duration / 1000).toFixed(1)}s)`);
        }

        await writeFile(
            join(OUTPUT_DIR, 'results.json'),
            JSON.stringify(results, null, 2),
        );

        // ── 8. Close browser and save video ───────────────────────────────
        const video = page.video();
        await context.close();
        await browser.close();
        browser = null;
        context = null;
        page = null;

        if (video) {
            const videoPath = await video.path();
            if (videoPath) {
                const finalPath = join(OUTPUT_DIR, 'walkthrough.webm');
                await copyFile(videoPath, finalPath);
                log(`Video saved to ${finalPath}`);
            }
        }

        // Disconnect
        node.disconnect();

    } catch (error) {
        log(`FATAL ERROR: ${error}`);
    } finally {
        // Cleanup
        if (page && context && browser) {
            try {
                await context.close();
                await browser.close();
            } catch {}
        }
        if (webServer) {
            webServer.process.kill('SIGTERM');
        }
        await teardownTestInfrastructure();
        log('Cleanup complete.');
    }
}

main().catch((error) => {
    console.error('Fatal:', error);
    process.exit(1);
});
