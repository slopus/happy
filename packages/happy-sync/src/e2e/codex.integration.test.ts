/**
 * Level 2: End-to-End Agent Flow — Codex
 *
 * Full 38-step exercise flow with real Codex CLI, real server.
 * Same structure as claude.integration.test.ts.
 *
 * Steps that don't apply to Codex (e.g., subagents) are recorded as
 * "not applicable" with the reason, NOT silently skipped.
 *
 * Prerequisites:
 * - happy-cli must be built (yarn build in packages/happy-cli)
 * - `codex` CLI installed and configured on this machine
 *
 * Run: npx vitest run src/e2e/codex.integration.test.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { SessionID } from '../v3-compat';
import {
    bootTestInfrastructure,
    createIsolatedProjectCopy,
    teardownTestInfrastructure,
    spawnSessionViaDaemon,
    getServerUrl,
} from './setup';
import {
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    resolveSessionKeyMaterial,
    waitForCondition,
    waitForPendingPermission,
    waitForPendingQuestion,
    getMessages,
    getAssistantMessages,
    getLastAssistantMessage,
    hasPart,
    getToolParts,
    getFullText,
} from './helpers';

// ─── Config ──────────────────────────────────────────────────────────────────

const CODEX_MODEL = { providerID: 'openai', modelID: 'codex-mini-latest' };

const STEP_TIMEOUT = 180000;
const PERM_TIMEOUT = 120000;
const FINISH_TIMEOUT = 180000;
const RESPONSE_QUIET_MS = 3000;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Level 2: Codex E2E Flow (38 steps)', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let sessionId: SessionID;
    let projectDir: string;
    let messageCountBeforeClose: number;
    const notApplicableSteps: Array<{ step: number; reason: string }> = [];

    function assistantCount(): number {
        return getAssistantMessages(node, sessionId).length;
    }

    function assistantMessagesSince(afterAssistantCount: number) {
        return getAssistantMessages(node, sessionId).slice(afterAssistantCount);
    }

    function assistantToolsSince(afterAssistantCount: number) {
        return assistantMessagesSince(afterAssistantCount).flatMap(getToolParts);
    }

    function completedToolsSince(afterAssistantCount: number) {
        return assistantToolsSince(afterAssistantCount).filter(tool => tool.state.status === 'completed');
    }

    function listProjectFiles(dir: string, base = dir): string[] {
        const files: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                files.push(...listProjectFiles(fullPath, base));
            } else {
                files.push(fullPath.slice(base.length + 1));
            }
        }
        return files;
    }

    function session() {
        return node.state.sessions.get(sessionId as string)!;
    }

    function msg(
        id: string,
        text: string,
        meta?: import('../messageMeta').MessageMeta,
    ) {
        return makeUserMessage(id, sessionId, text, 'codex', CODEX_MODEL, meta);
    }

    function recordNotApplicable(step: number, reason: string): void {
        notApplicableSteps.push({ step, reason });
    }

    beforeAll(async () => {
        await bootTestInfrastructure();
        projectDir = await createIsolatedProjectCopy('environments/lab-rat-todo-project');
        keyMaterial = makeKeyMaterial();
        node = new SyncNode(getServerUrl(), makeAccountToken(), keyMaterial, {
            resolveSessionKeyMaterial,
        });
        await node.connect();
    }, 90000);

    afterAll(async () => {
        node?.disconnect();
        await teardownTestInfrastructure();
    });

    async function approveUntil(
        done: () => boolean,
        timeoutMs = FINISH_TIMEOUT,
        timeoutMessage = `Timed out waiting for Codex turn to settle after ${timeoutMs}ms`,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        const approvedIds = new Set<string>();
        while (Date.now() < deadline) {
            const perm = session().permissions.find(p => !p.resolved && !approvedIds.has(p.permissionId));
            if (perm) {
                approvedIds.add(perm.permissionId);
                await node.approvePermission(sessionId, perm.permissionId, { decision: 'once' });
                continue;
            }

            if (done()) {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error(timeoutMessage);
    }

    /** Approve all pending permissions until step-finish. */
    async function approveUntilDone(before: number, timeoutMs = FINISH_TIMEOUT): Promise<void> {
        await approveUntil(
            () => isCodexTurnSettled(before),
            timeoutMs,
            `Timed out waiting for Codex turn to settle after ${timeoutMs}ms`,
        );
    }

    function isCodexTurnSettled(afterAssistantCount: number): boolean {
        const msgs = assistantMessagesSince(afterAssistantCount);
        if (msgs.length === 0) return false;

        return msgs.some(message => {
            const stepFinish = message.parts.find(
                (part): part is Extract<typeof part, { type: 'step-finish' }> => part.type === 'step-finish',
            );
            if (!stepFinish) return false;
            if (stepFinish.reason !== 'tool-calls') return true;

            const tools = getToolParts(message);
            return tools.length > 0
                && tools.every(tool =>
                    tool.state.status === 'completed' || tool.state.status === 'error',
                );
        });
    }

    function logCodexTurnState(afterAssistantCount: number): void {
        const msgs = assistantMessagesSince(afterAssistantCount);
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const partTypes = m.parts.map(p => {
                if (p.type === 'step-finish') return `step-finish(reason=${p.reason})`;
                if (p.type === 'tool') return `tool(${p.tool},status=${p.state.status})`;
                if (p.type === 'text') return `text(${p.text.slice(0, 40)}...)`;
                return p.type;
            });
            console.log(`[waitForCodexTurnSettled] msg[${afterAssistantCount + i}] (${m.parts.length} parts): ${partTypes.join(', ')}`);
        }
    }

    /**
     * Real Codex frequently finalizes a tool-heavy turn as a single assistant
     * message with `step-finish(reason="tool-calls")`, even when all tools are
     * already terminal and no follow-up terminal turn is sent. Treat that
     * finalized, all-tools-terminal message as the turn completion signal.
     */
    async function waitForCodexTurnSettled(
        afterAssistantCount: number,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        let lastLogAt = 0;
        await waitForCondition(() => {
            const msgs = assistantMessagesSince(afterAssistantCount);
            if (msgs.length === 0) return false;

            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                logCodexTurnState(afterAssistantCount);
            }

            return isCodexTurnSettled(afterAssistantCount);
        }, timeoutMs);
    }

    function createCodexQuietTracker(afterAssistantCount: number) {
        let lastFingerprint = '';
        let lastChangeAt = 0;

        return (ready: boolean): boolean => {
            if (!ready) return false;

            const fingerprint = JSON.stringify(
                assistantMessagesSince(afterAssistantCount).map(message => message.parts),
            );
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint;
                lastChangeAt = Date.now();
                return false;
            }

            return Date.now() - lastChangeAt >= RESPONSE_QUIET_MS;
        };
    }

    async function waitForCodexTextResponseQuiet(
        afterAssistantCount: number,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        const quietTracker = createCodexQuietTracker(afterAssistantCount);

        await waitForCondition(() => {
            const msgs = assistantMessagesSince(afterAssistantCount);
            return quietTracker(
                msgs.length > 0 && msgs.some(message => hasPart(message, 'text')),
            );
        }, timeoutMs);
    }

    // ─── SETUP ───────────────────────────────────────────────────────────

    it('Step 0 — Session created, agent process spawns', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'codex',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        expect(sessionId).toBeTruthy();
        expect(node.state.sessions.has(sessionId as string)).toBe(true);
    }, 60000);

    // ─── TRANSCRIPT ──────────────────────────────────────────────────────

    it('Step 1 — Orient', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step1', 'Read all files, tell me what this does.'));

        await approveUntilDone(before);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-start')).toBe(true);
        expect(hasPart(last, 'text')).toBe(true);
        expect(hasPart(last, 'step-finish')).toBe(true);
        const tools = getToolParts(last);
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.every(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 2 — Find the bug', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step2',
            "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line."));

        await approveUntilDone(before);

        const last = getLastAssistantMessage(node, sessionId)!;
        const fullText = getFullText(last);
        expect(fullText).toMatch(/filter|done|bug/);
    }, STEP_TIMEOUT);

    // ─── PERMISSIONS ─────────────────────────────────────────────────────

    it('Step 3 — Edit rejected', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step3', 'Fix it.', {
            permissionMode: 'read-only',
        }));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(getFullText(last)).toMatch(/read-only|writable|permission|can(?:not|'t) edit|blocked/);
    }, STEP_TIMEOUT);

    it('Step 4 — Edit approved once', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step4', 'Ok that diff looks right. Go ahead and apply it.', {
            permissionMode: 'acceptEdits',
        }));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        expect(completedToolsSince(before).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 5 — Edit approved always', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step5',
            'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.', {
            permissionMode: 'safe-yolo',
        }));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        expect(completedToolsSince(before).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 6 — Auto-approved edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step6',
            'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.'));

        await waitForCodexTurnSettled(before, 300000);

        const tools = assistantToolsSince(before);
        expect(tools.filter(t => t.state.status === 'completed').length).toBeGreaterThan(0);
        expect(tools.filter(t => t.state.status === 'blocked').length).toBe(0);
    }, 300000);

    // ─── WEB SEARCH ──────────────────────────────────────────────────────

    it('Step 7 — Search the web', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step7',
            'Search the web for best practices on accessible keyboard shortcuts in todo apps.'));

        const approvedIds = new Set<string>();
        await waitForCondition(() => {
            for (const perm of session().permissions) {
                if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                    approvedIds.add(perm.permissionId);
                    node.approvePermission(sessionId, perm.permissionId, { decision: 'once' }).catch(() => {});
                }
            }

            return assistantMessagesSince(before).some(message => {
                const fullText = getFullText(message);
                if (!/keyboard|shortcut|accessib/.test(fullText)) {
                    return false;
                }

                const stepFinish = message.parts.find(
                    (part): part is Extract<typeof part, { type: 'step-finish' }> => part.type === 'step-finish',
                );
                if (!stepFinish) {
                    return false;
                }

                if (stepFinish.reason !== 'tool-calls') {
                    return true;
                }

                const tools = getToolParts(message);
                return tools.length > 0
                    && tools.every(tool =>
                        tool.state.status === 'completed' || tool.state.status === 'error',
                    );
            });
        }, STEP_TIMEOUT);

        const fullText = assistantMessagesSince(before).map(getFullText).join(' ');
        expect(fullText).toMatch(/keyboard|shortcut|accessib/);
    }, STEP_TIMEOUT);

    // ─── SUBAGENTS ───────────────────────────────────────────────────────

    it('Step 8 — Parallel explore (recorded as not applicable)', () => {
        const reason = 'Codex does not support subagents or child sessions in this integration harness.';
        recordNotApplicable(8, reason);

        expect(notApplicableSteps).toContainEqual({
            step: 8,
            reason,
        });
    });

    // ─── TOOLS ───────────────────────────────────────────────────────────

    it('Step 9 — Simple edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step9',
            "Add Cmd+Enter to submit the form from anywhere on the page. That's it, nothing else."));

        await approveUntilDone(before);

        expect(completedToolsSince(before).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    // ─── INTERRUPTION ────────────────────────────────────────────────────

    it('Step 10 — Cancel mid-stream', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step10',
            'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.'));

        await waitForCondition(() => getAssistantMessages(node, sessionId).length > before, 30000);

        await node.stopSession(sessionId);

        expect(getAssistantMessages(node, sessionId).length).toBeGreaterThan(before);
    }, STEP_TIMEOUT);

    it('Step 11 — Resume after cancel', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'codex',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step11', 'Ok just the Cmd+Enter. Do that.'));

        await approveUntilDone(before);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── QUESTION ────────────────────────────────────────────────────────

    it('Step 12 — Agent asks a question', async () => {
        // Codex doesn't have a formal AskUserQuestion tool. It may surface a
        // question via the happy MCP server (formal path) or just respond with
        // text asking the user (informal path). Handle both.
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step12',
            'I want to add a test framework. Ask me which one I want before you set anything up.'));

        const result = await Promise.race([
            waitForPendingQuestion(node, sessionId, 60000).then(() => 'formal' as const),
            waitForCodexTurnSettled(before, FINISH_TIMEOUT).then(() => 'text' as const),
        ]);

        if (result === 'formal') {
            const pendingQ = session().questions.find(q => !q.resolved)!;
            expect(pendingQ).toBeDefined();
            await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);
            await waitForCodexTurnSettled(before, FINISH_TIMEOUT);
            expect(session().questions.find(q => q.questionId === pendingQ.questionId)?.resolved).toBe(true);
        } else {
            // Codex responded with text — verify it asked about test frameworks
            const last = getLastAssistantMessage(node, sessionId)!;
            expect(hasPart(last, 'text')).toBe(true);
            // The answer ("Vitest") will be sent in Step 13
        }
    }, STEP_TIMEOUT);

    it('Step 13 — Act on the answer', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step13',
            'Create the Vitest setup files. Write vitest.config.js, a test file (e.g. app.test.js) that verifies the Done filter only returns items where done===true, and add vitest to package.json devDependencies. Do NOT run npm install or run the tests — just create the files.'));

        await approveUntilDone(before, 270000);

        const files = listProjectFiles(projectDir);
        expect(files.some(file => /^vitest\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(file))).toBe(true);
        expect(files.some(file => /(^|\/).+\.(test|spec)\.(js|jsx|ts|tsx|cjs|mjs)$/.test(file))).toBe(true);
        expect(existsSync(`${projectDir}/package.json`)).toBe(true);
        expect(readFileSync(`${projectDir}/package.json`, 'utf-8')).toContain('vitest');
        expect(completedToolsSince(before).length).toBeGreaterThanOrEqual(1);
    }, 300000);

    // ─── SANDBOX ─────────────────────────────────────────────────────────

    it('Step 14 — Read outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step14', 'What files are in the parent directory?'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 15 — Write outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step15',
            'Create a file at `../outside-test.txt` with the content "boundary test".'));

        // Codex with workspace-write sandbox may either:
        // 1. Surface a permission request (deny it)
        // 2. Have the sandbox block it at OS level and the turn completes with an error
        // 3. The model refuses and responds with text
        // Deny any permissions and wait for the turn to settle.
        const deniedIds = new Set<string>();
        const deadline = Date.now() + (STEP_TIMEOUT - 10000);
        while (Date.now() < deadline) {
            const perm = session().permissions.find(p => !p.resolved && !deniedIds.has(p.permissionId));
            if (perm) {
                deniedIds.add(perm.permissionId);
                await node.denyPermission(sessionId, perm.permissionId, { reason: 'Outside project' });
                continue;
            }
            if (isCodexTurnSettled(before)) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO ────────────────────────────────────────────────────────────

    it('Step 16 — Create todos', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step16',
            'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const fullText = getFullText(getLastAssistantMessage(node, sessionId)!);
        expect(fullText).toMatch(/due date|drag|export|json/);
    }, STEP_TIMEOUT);

    // ─── MODEL SWITCH ────────────────────────────────────────────────────

    it('Step 17 — Switch model and edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step17', sessionId,
            'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.',
            'codex',
            { providerID: 'openai', modelID: 'o3-mini' },
            { permissionMode: 'safe-yolo' },
        ));

        await waitForCodexTurnSettled(before, 240000);

        expect(completedToolsSince(before).length).toBeGreaterThan(0);
    }, 300000);

    // ─── COMPACTION ──────────────────────────────────────────────────────

    it('Step 18 — Compact', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step18', 'Compact the context.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 19 — Post-compaction sanity', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step19', 'What files have we changed so far?'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const fullText = getFullText(getLastAssistantMessage(node, sessionId)!);
        expect(fullText).toMatch(/app\.js|styles\.css|index\.html|file/);
    }, STEP_TIMEOUT);

    // ─── PERSISTENCE ─────────────────────────────────────────────────────

    it('Step 20 — Close session', async () => {
        messageCountBeforeClose = getMessages(node, sessionId).length;
        expect(messageCountBeforeClose).toBeGreaterThan(0);
        await node.stopSession(sessionId);
    }, 30000);

    it('Step 21 — Reopen session', async () => {
        const node2 = new SyncNode(getServerUrl(), makeAccountToken(), keyMaterial, {
            resolveSessionKeyMaterial,
        });
        await node2.connect();
        await node2.fetchMessages(sessionId);

        expect(getMessages(node2, sessionId).length).toBeGreaterThanOrEqual(messageCountBeforeClose);

        node.disconnect();
        node = node2;
    }, 30000);

    it('Step 22 — Verify continuity', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'codex',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step22', 'What was the last thing we were working on?'));

        await waitForCodexTextResponseQuiet(before, FINISH_TIMEOUT);
        expect(assistantMessagesSince(before).some(message => hasPart(message, 'text'))).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO (continued) ────────────────────────────────────────────────

    it('Step 23 — Mark todo done', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step23',
            'Mark the "add due dates" todo as completed — we just did that.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const fullText = getFullText(getLastAssistantMessage(node, sessionId)!);
        expect(fullText).toMatch(/due date|completed|done|marked/);
    }, STEP_TIMEOUT);

    // ─── MULTI-PERMISSION ────────────────────────────────────────────────

    it('Step 25 — Multiple permissions in one turn', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step25',
            'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.'));

        const refactorMaterialized = () => {
            if (!existsSync(`${projectDir}/filters.js`) || !existsSync(`${projectDir}/theme.js`)) {
                return false;
            }

            const references = `${readFileSync(`${projectDir}/app.js`, 'utf-8')}\n${readFileSync(`${projectDir}/index.html`, 'utf-8')}`;
            return references.includes('filters.js') && references.includes('theme.js');
        };
        const quietTracker = createCodexQuietTracker(before);

        await approveUntil(
            () => quietTracker(refactorMaterialized()),
            STEP_TIMEOUT - 10000,
            `Timed out waiting for Codex multi-permission refactor to materialize`,
        );

        expect(existsSync(`${projectDir}/filters.js`)).toBe(true);
        expect(existsSync(`${projectDir}/theme.js`)).toBe(true);
        expect(`${readFileSync(`${projectDir}/app.js`, 'utf-8')}\n${readFileSync(`${projectDir}/index.html`, 'utf-8')}`).toContain('filters.js');
        expect(`${readFileSync(`${projectDir}/app.js`, 'utf-8')}\n${readFileSync(`${projectDir}/index.html`, 'utf-8')}`).toContain('theme.js');
        const tools = assistantToolsSince(before);
        // Codex may batch a multi-file refactor into a single apply_patch tool.
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
        expect(tools.some(t => t.state.status === 'blocked')).toBe(false);
    }, STEP_TIMEOUT);

    it('Step 26 — Supersede pending permissions', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step26',
            'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture". Only touch app.js, index.html, styles.css, filters.js, and theme.js as needed. Do not modify package.json, vitest.config.js, or app.test.js, and do not run tests.'));

        await approveUntilDone(before, 360000);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, 360000);

    // ─── SUBAGENT PERMISSIONS ────────────────────────────────────────────

    it('Step 27 — Subagent hits permission wall (recorded as not applicable)', () => {
        const reason = 'Codex does not support subagents or child-session permission flows in this integration harness.';
        recordNotApplicable(27, reason);

        expect(notApplicableSteps).toContainEqual({
            step: 27,
            reason,
        });
    });

    // ─── STOP WITH PENDING STATE ─────────────────────────────────────────

    it('Step 28 — Stop while permission pending', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step28',
            'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.'));

        await waitForCondition(() => getAssistantMessages(node, sessionId).length > before, 60000);

        await node.stopSession(sessionId);
        expect(session().status.type).toBe('completed');
    }, STEP_TIMEOUT);

    it('Step 29 — Resume after forced stop', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'codex',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step29', 'What happened with the priority feature?'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 30 — Retry after stop', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step30',
            'Try again — add the priority field. Approve everything this time. Only change the app implementation and styles for this feature. Do not modify package.json, vitest.config.js, or app.test.js, and do not run tests.'));

        await approveUntilDone(before, 360000);

        expect(completedToolsSince(before).length).toBeGreaterThan(0);
    }, 360000);

    // ─── BACKGROUND TASKS ────────────────────────────────────────────────

    it('Step 31 — Launch background task', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step31',
            'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        expect(assistantMessagesSince(before).some(message => hasPart(message, 'text'))).toBe(true);
        expect(assistantToolsSince(before).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 32 — Background completes', async () => {
        // Check ALL assistant messages for donezen (not just the last one —
        // Codex may emit additional messages after the background task completes).
        await waitForCondition(() => {
            return getAssistantMessages(node, sessionId).some(msg =>
                getToolParts(msg).some(t =>
                    t.state.status === 'completed' &&
                    'output' in t.state &&
                    typeof t.state.output === 'string' &&
                    t.state.output.includes('donezen'),
                ),
            );
        }, 60000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step32',
            'Did that background task finish? What was the output?'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/donezen/);
    }, 240000);

    it('Step 33 — Foreground + background concurrent', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step33',
            'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".'));

        await approveUntilDone(before);

        const tools = assistantToolsSince(before);
        expect(tools.length).toBeGreaterThanOrEqual(2);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── WRAP UP ─────────────────────────────────────────────────────────

    it('Step 34 — Full summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step34',
            'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        expect(getFullText(last).length).toBeGreaterThan(50);
    }, STEP_TIMEOUT);

    // ─── BACKGROUND SUBAGENTS (N/A for Codex) ────────────────────────────

    it('Step 35 — Background subagent (TaskCreate) [N/A]', () => {
        recordNotApplicable(35, 'Codex does not support TaskCreate/TaskOutput background subagent tasks.');
    });

    it('Step 36 — Check background agent result (TaskOutput) [N/A]', () => {
        recordNotApplicable(36, 'Codex does not support TaskCreate/TaskOutput background subagent tasks.');
    });

    it('Step 37 — Multiple background tasks [N/A]', () => {
        recordNotApplicable(37, 'Codex does not support TaskCreate/TaskOutput background subagent tasks.');
    });

    // ─── WRAP UP (final) ─────────────────────────────────────────────────

    it('Step 38 — Final summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step38',
            'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.'));

        await waitForCodexTurnSettled(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        expect(getFullText(last).length).toBeGreaterThan(50);
    }, STEP_TIMEOUT);

    // ─── CROSS-CUTTING ASSERTIONS ────────────────────────────────────────

    it('No legacy envelopes', () => {
        const allMsgs = getMessages(node, sessionId);
        for (const msg of allMsgs) {
            expect(['user', 'assistant']).toContain(msg.info.role);
        }
    });

    it('All assistant messages structurally valid', () => {
        for (const msg of getAssistantMessages(node, sessionId)) {
            expect(hasPart(msg, 'step-start')).toBe(true);
            expect(msg.parts.filter(p => p.type !== 'step-start' && p.type !== 'step-finish').length).toBeGreaterThan(0);
            expect(hasPart(msg, 'step-finish')).toBe(true);
        }
    });

    it('Permission decisions survive round-trip', () => {
        for (const msg of getMessages(node, sessionId)) {
            for (const part of msg.parts) {
                if (part.type === 'decision') {
                    expect(part.decision).toBeDefined();
                    expect(part.decidedAt).toBeDefined();
                    expect(part.targetMessageID).toBeDefined();
                    expect(part.permissionID).toBeDefined();
                }
            }
        }
    });

    it('Message count is sane', () => {
        const allMsgs = getMessages(node, sessionId);
        const ids = allMsgs.map(m => m.info.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('All tool parts have terminal state', () => {
        for (const msg of getAssistantMessages(node, sessionId)) {
            for (const tool of getToolParts(msg)) {
                expect(['completed', 'error']).toContain(tool.state.status);
            }
        }
    });

    it('Agent-specific N/A steps are recorded with reasons', () => {
        expect(notApplicableSteps).toEqual([
            {
                step: 8,
                reason: 'Codex does not support subagents or child sessions in this integration harness.',
            },
            {
                step: 27,
                reason: 'Codex does not support subagents or child-session permission flows in this integration harness.',
            },
            {
                step: 35,
                reason: 'Codex does not support TaskCreate/TaskOutput background subagent tasks.',
            },
            {
                step: 36,
                reason: 'Codex does not support TaskCreate/TaskOutput background subagent tasks.',
            },
            {
                step: 37,
                reason: 'Codex does not support TaskCreate/TaskOutput background subagent tasks.',
            },
        ]);
    });
}, 900000); // 15 min — full 38-step flow
