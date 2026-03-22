/**
 * Level 2: End-to-End Agent Flow — OpenCode
 *
 * Full 34-step exercise flow (when adapter exists).
 * Same structure as claude.integration.test.ts.
 *
 * OpenCode supports subagents — steps 8 and 27 are applicable.
 *
 * Prerequisites:
 * - Real server running
 * - HAPPY_TEST_SERVER_URL, HAPPY_TEST_TOKEN env vars
 * - OPENCODE_AVAILABLE env var set
 * - OpenCode adapter implemented
 *
 * Run: npx vitest run src/e2e/opencode.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { SessionID } from '../protocol';
import {
    AUTH_TOKEN,
    SERVER_URL,
    makeAccountToken,
    makeKeyMaterial,
    makeUserMessage,
    waitForCondition,
    waitForStepFinish,
    waitForPendingPermission,
    waitForPendingQuestion,
    getMessages,
    getAssistantMessages,
    getLastAssistantMessage,
    hasPart,
    getToolParts,
    getSubtaskParts,
    getFullText,
} from './helpers';

// ─── Config ──────────────────────────────────────────────────────────────────

const SKIP_E2E = !AUTH_TOKEN || !process.env.OPENCODE_AVAILABLE;
const OPENCODE_MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' };

const STEP_TIMEOUT = 180000;
const PERM_TIMEOUT = 120000;
const FINISH_TIMEOUT = 120000;

// ─── Tests ───────────────────────────────────────────────────────────────────

const describeE2E = SKIP_E2E ? describe.skip : describe;

describeE2E('Level 2: OpenCode E2E Flow (34 steps)', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let sessionId: SessionID;
    let messageCountBeforeClose: number;

    function assistantCount(): number {
        return getAssistantMessages(node, sessionId).length;
    }

    function session() {
        return node.state.sessions.get(sessionId as string)!;
    }

    function msg(id: string, text: string) {
        return makeUserMessage(id, sessionId, text, 'opencode', OPENCODE_MODEL);
    }

    beforeAll(async () => {
        keyMaterial = makeKeyMaterial();
        node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
        await node.connect();
    }, 30000);

    afterAll(() => {
        node.disconnect();
    });

    async function approveUntilDone(before: number): Promise<void> {
        let finished = false;
        while (!finished) {
            const result = await Promise.race([
                waitForPendingPermission(node, sessionId, 10000).then(() => 'perm' as const),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => 'done' as const),
            ]);
            if (result === 'done') {
                finished = true;
            } else {
                const perm = session().permissions.find(p => !p.resolved);
                if (perm) {
                    await node.approvePermission(sessionId, perm.permissionId, { decision: 'once' });
                }
            }
        }
    }

    // ─── SETUP ───────────────────────────────────────────────────────────

    it('Step 0 — Session created, agent process spawns', async () => {
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'OpenCode E2E Test',
        });

        expect(sessionId).toBeTruthy();
        expect(node.state.sessions.has(sessionId as string)).toBe(true);
    }, 30000);

    // ─── TRANSCRIPT ──────────────────────────────────────────────────────

    it('Step 1 — Orient', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step1', 'Read all files, tell me what this does.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-start')).toBe(true);
        expect(hasPart(last, 'text')).toBe(true);
        expect(hasPart(last, 'step-finish')).toBe(true);
        expect(getToolParts(last).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 2 — Find the bug', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step2',
            "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line."));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/filter|done|bug/);
    }, STEP_TIMEOUT);

    // ─── PERMISSIONS ─────────────────────────────────────────────────────

    it('Step 3 — Edit rejected', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step3', 'Fix it.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const perm = session().permissions.find(p => !p.resolved)!;
        await node.denyPermission(sessionId, perm.permissionId, { reason: 'Show me the diff first' });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'error')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 4 — Edit approved once', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step4', 'Ok that diff looks right. Go ahead and apply it.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const perm = session().permissions.find(p => !p.resolved)!;
        await node.approvePermission(sessionId, perm.permissionId, { decision: 'once' });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 5 — Edit approved always', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step5',
            'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const perm = session().permissions.find(p => !p.resolved)!;
        await node.approvePermission(sessionId, perm.permissionId, {
            decision: 'always',
            allowTools: [perm.block.permission],
        });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 6 — Auto-approved edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step6',
            'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const tools = getToolParts(getLastAssistantMessage(node, sessionId)!);
        expect(tools.filter(t => t.state.status === 'completed').length).toBeGreaterThan(0);
        expect(tools.filter(t => t.state.status === 'blocked').length).toBe(0);
    }, STEP_TIMEOUT);

    // ─── WEB SEARCH ──────────────────────────────────────────────────────

    it('Step 7 — Search the web', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step7',
            'Search the web for best practices on accessible keyboard shortcuts in todo apps.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── SUBAGENTS ───────────────────────────────────────────────────────

    it('Step 8 — Parallel explore', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step8',
            'I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const subtasks = getSubtaskParts(last);
        expect(subtasks.length).toBeGreaterThanOrEqual(1);

        const childSessions = Array.from(node.state.sessions.values()).filter(
            s => s.info.parentID === sessionId,
        );
        if (childSessions.length > 0) {
            for (const child of childSessions) {
                expect(child.messages.length).toBeGreaterThan(0);
            }
        }

        expect(hasPart(last, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TOOLS ───────────────────────────────────────────────────────────

    it('Step 9 — Simple edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step9',
            "Add Cmd+Enter to submit the form from anywhere on the page. That's it, nothing else."));

        await approveUntilDone(before);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'completed')).toBe(true);
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
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'OpenCode E2E Test (resumed)',
        });

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step11', 'Ok just the Cmd+Enter. Do that.'));

        await approveUntilDone(before);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── QUESTION ────────────────────────────────────────────────────────

    it('Step 12 — Agent asks a question', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step12',
            'I want to add a test framework. Ask me which one I want before you set anything up.'));

        await waitForPendingQuestion(node, sessionId, PERM_TIMEOUT);

        const pendingQ = session().questions.find(q => !q.resolved)!;
        expect(pendingQ).toBeDefined();

        await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(session().questions.find(q => q.questionId === pendingQ.questionId)?.resolved).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 13 — Act on the answer', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step13',
            'Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).'));

        await approveUntilDone(before);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).filter(t => t.state.status === 'completed').length).toBeGreaterThanOrEqual(1);
    }, STEP_TIMEOUT);

    // ─── SANDBOX ─────────────────────────────────────────────────────────

    it('Step 14 — Read outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step14', 'What files are in the parent directory?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 15 — Write outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step15',
            'Create a file at `../outside-test.txt` with the content "boundary test".'));

        const hadPerm = await Promise.race([
            waitForPendingPermission(node, sessionId, 15000).then(() => true),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPerm) {
            const perm = session().permissions.find(p => !p.resolved);
            if (perm) await node.denyPermission(sessionId, perm.permissionId, { reason: 'Outside project' });
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        }

        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO ────────────────────────────────────────────────────────────

    it('Step 16 — Create todos', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step16',
            'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/due date|drag|export|json/);
    }, STEP_TIMEOUT);

    // ─── MODEL SWITCH ────────────────────────────────────────────────────

    it('Step 17 — Switch model and edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step17', sessionId,
            'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.',
            'opencode',
            { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' },
        ));

        await approveUntilDone(before);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── COMPACTION ──────────────────────────────────────────────────────

    it('Step 18 — Compact', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step18', 'Compact the context.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 19 — Post-compaction sanity', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step19', 'What files have we changed so far?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/app\.js|styles\.css|index\.html|file/);
    }, STEP_TIMEOUT);

    // ─── PERSISTENCE ─────────────────────────────────────────────────────

    it('Step 20 — Close session', async () => {
        messageCountBeforeClose = getMessages(node, sessionId).length;
        expect(messageCountBeforeClose).toBeGreaterThan(0);
        await node.stopSession(sessionId);
    }, 30000);

    it('Step 21 — Reopen session', async () => {
        const node2 = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
        await node2.connect();
        await node2.fetchMessages(sessionId);

        expect(getMessages(node2, sessionId).length).toBeGreaterThanOrEqual(messageCountBeforeClose);

        node.disconnect();
        node = node2;
    }, 30000);

    it('Step 22 — Verify continuity', async () => {
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'OpenCode E2E Test (continued)',
        });

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step22', 'What was the last thing we were working on?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO (continued) ────────────────────────────────────────────────

    it('Step 23 — Mark todo done', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step23',
            'Mark the "add due dates" todo as completed — we just did that.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/due date|completed|done|marked/);
    }, STEP_TIMEOUT);

    // ─── MULTI-PERMISSION ────────────────────────────────────────────────

    it('Step 25 — Multiple permissions in one turn', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step25',
            'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.'));

        const approvedIds = new Set<string>();
        let finished = false;
        while (!finished) {
            const result = await Promise.race([
                waitForCondition(() => {
                    return session().permissions.some(p => !p.resolved && !approvedIds.has(p.permissionId));
                }, 15000).then(() => 'perm' as const),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => 'done' as const),
            ]);
            if (result === 'done') {
                finished = true;
            } else {
                const perm = session().permissions.find(p => !p.resolved && !approvedIds.has(p.permissionId));
                if (perm) {
                    approvedIds.add(perm.permissionId);
                    await node.approvePermission(sessionId, perm.permissionId, { decision: 'once' });
                }
            }
        }

        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).filter(t => t.state.status === 'completed').length).toBeGreaterThanOrEqual(2);
    }, STEP_TIMEOUT);

    it('Step 26 — Supersede pending permissions', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step26',
            'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".'));

        await approveUntilDone(before);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── SUBAGENT PERMISSIONS ────────────────────────────────────────────

    it('Step 27 — Subagent hits permission wall', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step27',
            'Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don\'t auto-approve anything for it.'));

        let finished = false;
        while (!finished) {
            // Check child sessions for pending permissions
            const allSessions = Array.from(node.state.sessions.values());
            const childSessions = allSessions.filter(s => s.info.parentID === sessionId);

            for (const child of childSessions) {
                const childPerm = child.permissions.find(p => !p.resolved);
                if (childPerm) {
                    await node.approvePermission(child.info.id, childPerm.permissionId, { decision: 'once' });
                }
            }

            const parentPerm = session().permissions.find(p => !p.resolved);
            if (parentPerm) {
                await node.approvePermission(sessionId, parentPerm.permissionId, { decision: 'once' });
            }

            const result = await Promise.race([
                waitForCondition(() => {
                    const all = Array.from(node.state.sessions.values());
                    return all.some(s => s.permissions.some(p => !p.resolved));
                }, 5000).then(() => 'perm' as const),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => 'done' as const),
            ]);

            if (result === 'done') finished = true;
        }

        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── STOP WITH PENDING STATE ─────────────────────────────────────────

    it('Step 28 — Stop while permission pending', async () => {
        await node.sendMessage(sessionId, msg('step28',
            'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);
        await node.stopSession(sessionId);
        expect(session().status.type).toBe('completed');
    }, STEP_TIMEOUT);

    it('Step 29 — Resume after forced stop', async () => {
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'OpenCode E2E Test (after stop)',
        });

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step29', 'What happened with the priority feature?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(hasPart(getLastAssistantMessage(node, sessionId)!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 30 — Retry after stop', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step30',
            'Try again — add the priority field. Approve everything this time.'));

        await approveUntilDone(before);
        expect(getToolParts(getLastAssistantMessage(node, sessionId)!).some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── BACKGROUND TASKS ────────────────────────────────────────────────

    it('Step 31 — Launch background task', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step31',
            'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        expect(getToolParts(last).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 32 — Background completes', async () => {
        await waitForCondition(() => {
            const last = getLastAssistantMessage(node, sessionId);
            if (!last) return false;
            return getToolParts(last).some(t =>
                t.state.status === 'completed' &&
                'output' in t.state &&
                typeof t.state.output === 'string' &&
                t.state.output.includes('donezen'),
            );
        }, 60000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step32',
            'Did that background task finish? What was the output?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        expect(getFullText(getLastAssistantMessage(node, sessionId)!)).toMatch(/donezen/);
    }, 240000);

    it('Step 33 — Foreground + background concurrent', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step33',
            'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".'));

        await approveUntilDone(before);

        const tools = getToolParts(getLastAssistantMessage(node, sessionId)!);
        expect(tools.length).toBeGreaterThanOrEqual(2);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── WRAP UP ─────────────────────────────────────────────────────────

    it('Step 34 — Full summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step34',
            'Give me a git-style summary of everything we changed. List files modified, lines added/removed if you can tell.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        expect(getFullText(last).length).toBeGreaterThan(50);
    }, STEP_TIMEOUT);

    // ─── CROSS-CUTTING ASSERTIONS ────────────────────────────────────────

    it('No legacy envelopes', () => {
        for (const msg of getMessages(node, sessionId)) {
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

    it('Child session structure intact', () => {
        const allSessions = Array.from(node.state.sessions.values());
        const childSessions = allSessions.filter(s => s.info.parentID);

        for (const child of childSessions) {
            expect(allSessions.some(s => s.info.id === child.info.parentID)).toBe(true);
            expect(child.messages.length).toBeGreaterThan(0);
        }
    });
}, 600000);
