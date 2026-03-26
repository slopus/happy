#!/usr/bin/env npx tsx
/**
 * Phase 1 VISUAL Walkthrough — All 37 exercise steps + hold for agent-browser.
 *
 * Boots full e2e stack, walks through every exercise step against real Claude,
 * then HOLDS OPEN so agent-browser can take screenshots.
 *
 * Usage:
 *   npx tsx packages/happy-sync/src/e2e/phase1-visual.ts
 *
 * Writes connection info to /tmp/happy-phase1-visual.json
 * After all steps complete, holds until you kill it (Ctrl+C).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SyncNode } from '../sync-node';
import type { MessageWithParts, SessionID } from '../protocol';
import {
    bootTestInfrastructure,
    createIsolatedProjectCopy,
    getAuthToken,
    getEncryptionSecret,
    getServerUrl,
    getDaemonHttpPort,
    spawnSessionViaDaemon,
    teardownTestInfrastructure,
} from './setup';
import {
    getAssistantMessages,
    getMessages,
    getUserMessages,
    getTextParts,
    getToolParts,
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    resolveSessionKeyMaterial,
    waitForCondition,
    waitForStepFinish,
    waitForPendingPermission,
} from './helpers';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WEB_PORT = 19017;
const INFO_FILE = '/tmp/happy-phase1-visual.json';
const RESULTS_FILE = '/tmp/happy-phase1-visual-results.json';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function collectToolParts(msgs: MessageWithParts[], afterIdx: number): { tool: string; status: string }[] {
    const result: { tool: string; status: string }[] = [];
    for (let i = afterIdx; i < msgs.length; i++) {
        for (const part of getToolParts(msgs[i])) {
            result.push({
                tool: (part as any).tool ?? 'unknown',
                status: (part as any).state?.status ?? 'unknown',
            });
        }
    }
    return result;
}

function collectTextSnippet(msgs: MessageWithParts[], afterIdx: number): string {
    const texts: string[] = [];
    for (let i = afterIdx; i < msgs.length; i++) {
        for (const part of getTextParts(msgs[i])) {
            texts.push(part.text);
        }
    }
    return texts.join(' ').slice(0, 300);
}

async function waitForStepFinishApprovingAll(
    node: SyncNode,
    sessionId: SessionID,
    afterCount: number,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastApproveCheck = 0;

    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const now = Date.now();
            if (now > deadline) {
                clearInterval(timer);
                reject(new Error(`Step timed out after ${timeoutMs}ms`));
                return;
            }

            // Auto-approve permissions every 500ms
            if (now - lastApproveCheck > 500) {
                lastApproveCheck = now;
                const session = node.state.sessions.get(sessionId as string);
                if (session) {
                    for (const perm of session.permissions) {
                        if (!perm.resolved) {
                            log(`  Auto-approving permission: ${(perm as any).tool ?? 'unknown'}`);
                            node.approvePermission(sessionId, perm.permissionId, { decision: 'once' }).catch(() => {});
                        }
                    }
                    for (const q of session.questions) {
                        if (!q.resolved) {
                            log(`  Auto-answering question`);
                            node.answerQuestion(sessionId, q.questionId, [['Vitest']]).catch(() => {});
                        }
                    }
                }
            }

            // Check for step finish
            const msgs = getAssistantMessages(node, sessionId);
            if (msgs.length <= afterCount) return;
            for (let i = afterCount; i < msgs.length; i++) {
                const hasFinish = msgs[i].parts.some(
                    (p) => p.type === 'step-finish' && (p as any).reason !== 'tool-calls',
                );
                if (hasFinish) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
            }
        }, 300);
    });
}

// ─── Step Definitions ────────────────────────────────────────────────────────

interface StepDef {
    id: number;
    name: string;
    prompt: string | null;
    action: 'send' | 'spawn' | 'deny' | 'approve-once' | 'approve-always' | 'cancel' | 'stop' | 'reopen' | 'model-switch' | 'answer-then-send';
    timeoutMs: number;
    permissionAction?: 'deny' | 'approve-once' | 'approve-always' | 'auto' | 'wait-then-stop';
}

const STEPS: StepDef[] = [
    { id: 0, name: 'Open the agent', prompt: null, action: 'spawn', timeoutMs: 30000 },
    { id: 1, name: 'Orient', prompt: 'Read all files, tell me what this does.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 2, name: 'Find the bug', prompt: "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line.", action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 3, name: 'Edit rejected', prompt: 'Fix it.', action: 'send', timeoutMs: 120000, permissionAction: 'deny' },
    { id: 4, name: 'Edit approved once', prompt: 'Ok that diff looks right. Go ahead and apply it.', action: 'send', timeoutMs: 120000, permissionAction: 'approve-once' },
    { id: 5, name: 'Edit approved always', prompt: 'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.', action: 'send', timeoutMs: 120000, permissionAction: 'approve-always' },
    { id: 6, name: 'Auto-approved edit', prompt: 'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 7, name: 'Search the web', prompt: 'Search the web for best practices on accessible keyboard shortcuts in todo apps.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 8, name: 'Parallel explore', prompt: "I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.", action: 'send', timeoutMs: 240000, permissionAction: 'auto' },
    { id: 9, name: 'Simple edit', prompt: 'Add Cmd+Enter to submit the form from anywhere on the page. That\'s it, nothing else.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 10, name: 'Cancel', prompt: 'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.', action: 'cancel', timeoutMs: 30000 },
    { id: 11, name: 'Resume after cancel', prompt: 'Ok just the Cmd+Enter. Do that.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 12, name: 'Agent asks a question', prompt: "I want to add a test framework. Ask me which one I want before you set anything up.", action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 13, name: 'Act on the answer', prompt: 'Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).', action: 'send', timeoutMs: 300000, permissionAction: 'auto' },
    { id: 14, name: 'Read outside project', prompt: 'What files are in the parent directory?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 15, name: 'Write outside project', prompt: 'Create a file at `../outside-test.txt` with the content "boundary test".', action: 'send', timeoutMs: 120000, permissionAction: 'deny' },
    { id: 16, name: 'Create todos', prompt: 'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 17, name: 'Switch and edit', prompt: 'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.', action: 'model-switch', timeoutMs: 240000, permissionAction: 'auto' },
    { id: 18, name: 'Compact', prompt: 'Compact the context.', action: 'send', timeoutMs: 60000, permissionAction: 'auto' },
    { id: 19, name: 'Post-compaction sanity', prompt: 'What files have we changed so far?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 20, name: 'Close', prompt: null, action: 'stop', timeoutMs: 10000 },
    { id: 21, name: 'Reopen', prompt: null, action: 'reopen', timeoutMs: 30000 },
    { id: 22, name: 'Verify continuity', prompt: 'What was the last thing we were working on?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 23, name: 'Mark todo done', prompt: 'Mark the "add due dates" todo as completed — we just did that.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 25, name: 'Multiple permissions in one turn', prompt: "Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.", action: 'send', timeoutMs: 180000, permissionAction: 'approve-once' },
    { id: 26, name: 'Supersede pending permissions', prompt: 'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 27, name: 'Subagent hits a permission wall', prompt: 'Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don\'t auto-approve anything for it.', action: 'send', timeoutMs: 240000, permissionAction: 'auto' },
    { id: 28, name: 'Stop session while permission is pending', prompt: 'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.', action: 'send', timeoutMs: 120000, permissionAction: 'wait-then-stop' },
    { id: 29, name: 'Resume after forced stop', prompt: 'What happened with the priority feature?', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 30, name: 'Retry after stop', prompt: 'Try again — add the priority field. Approve everything this time.', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 31, name: 'Launch a background task', prompt: 'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 32, name: 'Background task completes', prompt: 'Did that background task finish? What was the output?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 33, name: 'Interact during background task', prompt: 'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 34, name: 'Full summary', prompt: 'Give me a git-style summary of everything we changed. List files modified, lines added/removed if you can tell.', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    // NEW Steps 35-37
    { id: 35, name: 'Background subagent (TaskCreate)', prompt: "Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works.", action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
    { id: 36, name: 'Check background agent result (TaskOutput)', prompt: 'Did that background research finish? What did it find?', action: 'send', timeoutMs: 120000, permissionAction: 'auto' },
    { id: 37, name: 'Multiple background tasks', prompt: 'Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".', action: 'send', timeoutMs: 180000, permissionAction: 'auto' },
];

// ─── Web app server ─────────────────────────────────────────────────────────

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
    child.stdout?.on('data', (chunk) => { /* ignore */ });
    child.stderr?.on('data', (chunk) => { /* ignore */ });
    return child;
}

async function waitForWebReady(timeoutMs = 300000): Promise<void> {
    const url = `http://127.0.0.1:${WEB_PORT}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Web app not ready after ${timeoutMs}ms`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    log('=== Phase 1 VISUAL Walkthrough: ALL 37 Exercise Steps ===');
    log('Booting infrastructure...');

    // 1. Boot server + daemon
    process.env.HAPPY_TEST_SERVER_PORT = '34191';
    await bootTestInfrastructure();
    log(`Server: ${getServerUrl()}`);
    log(`Daemon HTTP port: ${getDaemonHttpPort()}`);

    // 2. Copy project
    const projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
    log(`Project: ${projectDir}`);

    // 3. Start Expo web
    const webProcess = startWebAppServer(getServerUrl());
    log('Expo web dev server starting...');

    // 4. Create SyncNode
    const node = new SyncNode(
        getServerUrl(),
        makeAccountToken(),
        makeKeyMaterial(),
        { resolveSessionKeyMaterial },
    );
    await node.connect();
    log('SyncNode connected');

    // 5. Wait for web app
    log('Waiting for Expo web to be ready (first bundle can take 2-5 min)...');
    await waitForWebReady();
    log('Web app ready!');

    // 6. Spawn Claude session
    log('Spawning Claude session via daemon...');
    const sessionId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' });
    log(`Session: ${sessionId}`);

    await waitForCondition(() => node.state.sessions.has(sessionId), 30000);
    log('Session visible in SyncNode');

    const secret64url = encodeBase64Url(getEncryptionSecret());
    const webUrl = `http://127.0.0.1:${WEB_PORT}`;

    // Track all session IDs for screenshot URLs
    const allSessionIds: string[] = [sessionId];
    let currentSessionId = sessionId as SessionID;
    const CLAUDE_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };

    const makeSessionUrl = (sid: string) =>
        `${webUrl}/session/${sid}?dev_token=${encodeURIComponent(getAuthToken())}&dev_secret=${encodeURIComponent(secret64url)}`;
    const homeUrl = `${webUrl}/?dev_token=${encodeURIComponent(getAuthToken())}&dev_secret=${encodeURIComponent(secret64url)}`;

    // Write initial connection info
    const writeInfo = async () => {
        await writeFile(INFO_FILE, JSON.stringify({
            serverUrl: getServerUrl(),
            webUrl,
            homeUrl,
            allSessionUrls: allSessionIds.map(sid => ({ sessionId: sid, url: makeSessionUrl(sid) })),
            currentSessionId: currentSessionId as string,
            currentSessionUrl: makeSessionUrl(currentSessionId as string),
            authToken: getAuthToken(),
            secret64url,
            daemonPort: getDaemonHttpPort(),
            projectDir,
            status: 'running',
        }, null, 2));
    };
    await writeInfo();
    log(`Connection info: ${INFO_FILE}`);
    log(`Session URL: ${makeSessionUrl(sessionId)}`);

    // 7. Walk through all steps
    interface StepResult {
        stepId: number;
        name: string;
        durationMs: number;
        tools: { tool: string; status: string }[];
        textSnippet: string;
        error: string | null;
        sessionId: string;
    }
    const results: StepResult[] = [];

    for (const step of STEPS) {
        log(`\n${'='.repeat(60)}`);
        log(`Step ${step.id} — ${step.name}`);
        log(`${'='.repeat(60)}`);

        const start = Date.now();
        const beforeAssistant = getAssistantMessages(node, currentSessionId).length;
        let error: string | null = null;

        try {
            if (step.action === 'spawn') {
                const session = node.state.sessions.get(currentSessionId as string);
                log(`  Session status: ${JSON.stringify(session?.status)}`);

            } else if (step.action === 'stop') {
                log('  Stopping session...');
                await node.stopSession(currentSessionId);
                log('  Session stopped');

            } else if (step.action === 'reopen') {
                log('  Reopening — spawning new session...');
                const newId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' });
                await waitForCondition(() => node.state.sessions.has(newId), 30000);
                currentSessionId = newId as SessionID;
                allSessionIds.push(newId);
                await writeInfo();
                log(`  New session: ${currentSessionId}`);

            } else if (step.action === 'cancel') {
                log(`  Sending: "${step.prompt!.slice(0, 60)}..."`);
                await node.sendMessage(currentSessionId, makeUserMessage('test', currentSessionId, step.prompt!, 'claude', CLAUDE_MODEL));
                await new Promise((r) => setTimeout(r, 3000));
                log('  Cancelling...');
                await node.stopSession(currentSessionId);
                // Spawn new session for next step
                const newId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' });
                await waitForCondition(() => node.state.sessions.has(newId), 30000);
                currentSessionId = newId as SessionID;
                allSessionIds.push(newId);
                await writeInfo();
                log(`  New session: ${currentSessionId}`);

            } else if (step.action === 'model-switch') {
                log('  Switching model to haiku + sending prompt...');
                const msg = makeUserMessage('test', currentSessionId, step.prompt!, 'claude',
                    { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' },
                    { model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' } } as any);
                await node.sendMessage(currentSessionId, msg);
                await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);

            } else if (step.action === 'send') {
                log(`  Sending: "${step.prompt!.slice(0, 80)}${step.prompt!.length > 80 ? '...' : ''}"`);
                await node.sendMessage(currentSessionId, makeUserMessage('test', currentSessionId, step.prompt!, 'claude', CLAUDE_MODEL));

                if (step.permissionAction === 'deny') {
                    try {
                        await waitForPendingPermission(node, currentSessionId, 60000);
                        const session = node.state.sessions.get(currentSessionId as string);
                        const perm = session?.permissions.find((p) => !p.resolved);
                        if (perm) {
                            log(`  DENYING: ${(perm as any).tool ?? 'unknown'}`);
                            node.denyPermission(currentSessionId, perm.permissionId, { reason: 'No — show me the diff first.' });
                        }
                    } catch { log('  No permission appeared'); }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);

                } else if (step.permissionAction === 'approve-once') {
                    const approvedIds = new Set<string>();
                    const deadline = Date.now() + step.timeoutMs;
                    let settled = false;
                    while (!settled && Date.now() < deadline) {
                        const session = node.state.sessions.get(currentSessionId as string);
                        if (session) {
                            for (const perm of session.permissions) {
                                if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                                    log(`  Approving once: ${(perm as any).tool ?? 'unknown'}`);
                                    node.approvePermission(currentSessionId, perm.permissionId, { decision: 'once' }).catch(() => {});
                                    approvedIds.add(perm.permissionId);
                                }
                            }
                        }
                        const msgs = getAssistantMessages(node, currentSessionId);
                        for (let i = beforeAssistant; i < msgs.length; i++) {
                            if (msgs[i].parts.some((p) => p.type === 'step-finish' && (p as any).reason !== 'tool-calls')) {
                                settled = true;
                                break;
                            }
                        }
                        if (!settled) await new Promise((r) => setTimeout(r, 500));
                    }
                    if (!settled) throw new Error('Timed out');

                } else if (step.permissionAction === 'approve-always') {
                    try {
                        await waitForPendingPermission(node, currentSessionId, 60000);
                        const session = node.state.sessions.get(currentSessionId as string);
                        const perm = session?.permissions.find((p) => !p.resolved);
                        if (perm) {
                            log(`  Approving always: ${(perm as any).tool ?? 'unknown'}`);
                            node.approvePermission(currentSessionId, perm.permissionId, { decision: 'always' }).catch(() => {});
                        }
                    } catch { log('  No permission appeared'); }
                    await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);

                } else if (step.permissionAction === 'wait-then-stop') {
                    try {
                        await waitForPendingPermission(node, currentSessionId, 60000);
                        log('  Permission appeared — NOT approving, stopping session');
                    } catch { log('  No permission appeared'); }
                    await node.stopSession(currentSessionId);
                    const newId = await spawnSessionViaDaemon({ directory: projectDir, agent: 'claude' });
                    await waitForCondition(() => node.state.sessions.has(newId), 30000);
                    currentSessionId = newId as SessionID;
                    allSessionIds.push(newId);
                    await writeInfo();
                    log(`  New session: ${currentSessionId}`);

                } else if (step.permissionAction === 'auto') {
                    if (step.id === 12) {
                        // Question step
                        const deadline = Date.now() + step.timeoutMs;
                        let done = false;
                        while (!done && Date.now() < deadline) {
                            const session = node.state.sessions.get(currentSessionId as string);
                            if (session?.questions.some((q) => !q.resolved)) {
                                const q = session!.questions.find((q) => !q.resolved)!;
                                log('  Question received — answering "Vitest"');
                                node.answerQuestion(currentSessionId, q.questionId, [['Vitest']]);
                                done = true;
                            }
                            const msgs = getAssistantMessages(node, currentSessionId);
                            for (let i = beforeAssistant; i < msgs.length; i++) {
                                if (msgs[i].parts.some((p) => p.type === 'step-finish' && (p as any).reason !== 'tool-calls')) {
                                    done = true;
                                    break;
                                }
                            }
                            if (!done) await new Promise((r) => setTimeout(r, 500));
                        }
                        if (done) {
                            try { await waitForStepFinish(node, currentSessionId, beforeAssistant, 10000); } catch { /* ok */ }
                        }
                    } else {
                        await waitForStepFinishApprovingAll(node, currentSessionId, beforeAssistant, step.timeoutMs);
                    }
                }
            }
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            log(`  ERROR: ${error}`);
        }

        const elapsed = Date.now() - start;
        const assistantMsgs = getAssistantMessages(node, currentSessionId);
        const tools = collectToolParts(assistantMsgs, beforeAssistant);
        const textSnippet = collectTextSnippet(assistantMsgs, beforeAssistant);

        results.push({
            stepId: step.id,
            name: step.name,
            durationMs: elapsed,
            tools,
            textSnippet,
            error,
            sessionId: currentSessionId as string,
        });

        log(`  Duration: ${(elapsed / 1000).toFixed(1)}s | Tools: ${tools.map((t) => `${t.tool}:${t.status}`).join(', ') || 'none'}`);
        if (error) log(`  Error: ${error}`);

        // Write progress
        await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2));
        await writeInfo();
    }

    // 8. Summary
    log('\n' + '='.repeat(60));
    log('ALL 37 STEPS COMPLETE — READY FOR SCREENSHOTS');
    log('='.repeat(60));
    log(`Passed: ${results.filter((r) => !r.error).length}/${results.length}`);
    log(`Failed: ${results.filter((r) => r.error).length}`);
    log(`\nSession URLs:`);
    for (const sid of allSessionIds) {
        log(`  ${makeSessionUrl(sid)}`);
    }
    log(`Home URL: ${homeUrl}`);
    log(`\nInfo file: ${INFO_FILE}`);
    log(`Results file: ${RESULTS_FILE}`);

    // Update info with final status
    await writeFile(INFO_FILE, JSON.stringify({
        serverUrl: getServerUrl(),
        webUrl,
        homeUrl,
        allSessionUrls: allSessionIds.map(sid => ({ sessionId: sid, url: makeSessionUrl(sid) })),
        currentSessionId: currentSessionId as string,
        currentSessionUrl: makeSessionUrl(currentSessionId as string),
        authToken: getAuthToken(),
        secret64url,
        daemonPort: getDaemonHttpPort(),
        projectDir,
        status: 'ready_for_screenshots',
        stepResults: results,
    }, null, 2));

    // 9. HOLD OPEN — wait for SIGTERM
    log('\nHolding open for agent-browser screenshots. Press Ctrl+C to tear down.');
    await new Promise<void>((resolve) => {
        process.on('SIGTERM', resolve);
        process.on('SIGINT', resolve);
    });

    // 10. Teardown
    log('Tearing down...');
    webProcess.kill('SIGTERM');
    await teardownTestInfrastructure();
    log('Done.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
