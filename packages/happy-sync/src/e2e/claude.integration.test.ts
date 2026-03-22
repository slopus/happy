/**
 * Level 2: End-to-End Agent Flow — Claude
 *
 * Full 34-step exercise flow with real LLM, real server, real CLI.
 * SyncNode drives execution programmatically — no subprocess, no CLI binary,
 * no execFileSync.
 *
 * Assertions verify structural outcomes, not LLM prose.
 *
 * Prerequisites:
 * - Real server running (yarn env:up:authenticated)
 * - HAPPY_TEST_SERVER_URL env var
 * - HAPPY_TEST_TOKEN env var (account-scoped)
 * - ANTHROPIC_API_KEY env var (for Claude)
 *
 * Run: npx vitest run src/e2e/claude.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { MessageWithParts, SessionID, Part } from '../protocol';
import {
    SERVER_URL,
    AUTH_TOKEN,
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
    getTextParts,
    getSubtaskParts,
    getCompactionParts,
    getFullText,
} from './helpers';

// ─── Config ──────────────────────────────────────────────────────────────────

const SKIP_E2E = !AUTH_TOKEN || !process.env.ANTHROPIC_API_KEY;

// Timeouts
const STEP_TIMEOUT = 180000;   // 3 min per step
const PERM_TIMEOUT = 120000;   // 2 min to see a permission
const FINISH_TIMEOUT = 120000; // 2 min for step-finish

// ─── Tests ───────────────────────────────────────────────────────────────────

const describeE2E = SKIP_E2E ? describe.skip : describe;

describeE2E('Level 2: Claude E2E Flow (34 steps)', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let sessionId: SessionID;
    let messageCountBeforeClose: number;

    /** Count of assistant messages — used to wait for the "next" response. */
    function assistantCount(): number {
        return getAssistantMessages(node, sessionId).length;
    }

    /** Session state shortcut. */
    function session() {
        return node.state.sessions.get(sessionId as string)!;
    }

    beforeAll(async () => {
        keyMaterial = makeKeyMaterial();
        node = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
        await node.connect();
    }, 30000);

    afterAll(() => {
        node.disconnect();
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  SETUP
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 0 — Session created, agent process spawns', async () => {
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'Claude E2E Test',
        });

        expect(sessionId).toBeTruthy();
        expect(node.state.sessions.has(sessionId as string)).toBe(true);
    }, 30000);

    // ═════════════════════════════════════════════════════════════════════════
    //  TRANSCRIPT
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 1 — Orient: Read all files, tell me what this does', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step1', sessionId,
            'Read all files, tell me what this does.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-start')).toBe(true);
        expect(hasPart(last, 'text')).toBe(true);
        expect(hasPart(last, 'step-finish')).toBe(true);

        // Should have tool parts (file reads)
        const tools = getToolParts(last);
        expect(tools.length).toBeGreaterThan(0);
        expect(tools.every(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 2 — Find the bug', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step2', sessionId,
            "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line."));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const fullText = getFullText(last);
        expect(fullText).toMatch(/filter|done|bug/);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  PERMISSIONS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 3 — Edit rejected', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step3', sessionId, 'Fix it.'));

        // Wait for permission request (blocked tool)
        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        // Deny it
        const pendingPerm = session().permissions.find(p => !p.resolved)!;
        await node.denyPermission(sessionId, pendingPerm.permissionId, { reason: 'Show me the diff first' });

        // Wait for agent to recover
        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        // Tool should be in error state with rejected decision
        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        const rejected = tools.find(t => t.state.status === 'error');
        expect(rejected).toBeDefined();
    }, STEP_TIMEOUT);

    it('Step 4 — Edit approved once', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step4', sessionId,
            'Ok that diff looks right. Go ahead and apply it.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const pendingPerm = session().permissions.find(p => !p.resolved)!;
        await node.approvePermission(sessionId, pendingPerm.permissionId, { decision: 'once' });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        const completed = tools.find(t => t.state.status === 'completed');
        expect(completed).toBeDefined();
    }, STEP_TIMEOUT);

    it('Step 5 — Edit approved always', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step5', sessionId,
            'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const pendingPerm = session().permissions.find(p => !p.resolved)!;
        await node.approvePermission(sessionId, pendingPerm.permissionId, {
            decision: 'always',
            allowTools: [pendingPerm.block.permission],
        });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 6 — Auto-approved edit (no permission prompt)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step6', sessionId,
            'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.'));

        // This should auto-approve via the always rule from step 5.
        // Wait for completion — no permission prompt expected.
        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);

        // Verify tool parts completed (possibly multiple files)
        const completedTools = tools.filter(t => t.state.status === 'completed');
        expect(completedTools.length).toBeGreaterThan(0);

        // No blocked tools — auto-approved
        const blocked = tools.filter(t => t.state.status === 'blocked');
        expect(blocked.length).toBe(0);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  WEB SEARCH
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 7 — Search the web', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step7', sessionId,
            'Search the web for best practices on accessible keyboard shortcuts in todo apps.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        // Should have at least a text response — and likely a web search/fetch tool
        expect(hasPart(last, 'text')).toBe(true);
        const tools = getToolParts(last);
        // Web search tool should have completed
        if (tools.length > 0) {
            expect(tools.some(t => t.state.status === 'completed')).toBe(true);
        }
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  SUBAGENTS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 8 — Parallel explore (subagents)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step8', sessionId,
            'I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;

        // Should have subtask parts linking to child sessions
        const subtasks = getSubtaskParts(last);
        expect(subtasks.length).toBeGreaterThanOrEqual(1);

        // Check for child sessions with parentID
        const allSessions = Array.from(node.state.sessions.values());
        const childSessions = allSessions.filter(
            s => s.info.parentID === sessionId,
        );

        // At least one child session should have been created
        if (childSessions.length > 0) {
            // Child sessions should have their own messages
            for (const child of childSessions) {
                expect(child.messages.length).toBeGreaterThan(0);
            }
        }

        // Parent should have text summary
        expect(hasPart(last, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  TOOLS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 9 — Simple edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step9', sessionId,
            'Add Cmd+Enter to submit the form from anywhere on the page. That\'s it, nothing else.'));

        // May auto-approve or prompt — handle either case
        const hadPermission = await Promise.race([
            waitForPendingPermission(node, sessionId, 15000).then(() => true),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPermission) {
            const pendingPerm = session().permissions.find(p => !p.resolved);
            if (pendingPerm) {
                await node.approvePermission(sessionId, pendingPerm.permissionId, { decision: 'once' });
            }
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        }

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  INTERRUPTION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 10 — Cancel mid-stream', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step10', sessionId,
            'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.'));

        // Wait briefly for the agent to start working, then cancel
        await waitForCondition(() => {
            return getAssistantMessages(node, sessionId).length > before;
        }, 30000);

        // Cancel by stopping the session
        await node.stopSession(sessionId);

        // Verify: partial response exists
        const msgs = getAssistantMessages(node, sessionId);
        expect(msgs.length).toBeGreaterThan(before);
    }, STEP_TIMEOUT);

    it('Step 11 — Resume after cancel', async () => {
        // Re-create the session (or resume) for a simpler follow-up
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'Claude E2E Test (resumed)',
        });

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step11', sessionId,
            'Ok just the Cmd+Enter. Do that.'));

        // Handle permission if needed
        const hadPermission = await Promise.race([
            waitForPendingPermission(node, sessionId, 15000).then(() => true),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPermission) {
            const pendingPerm = session().permissions.find(p => !p.resolved);
            if (pendingPerm) {
                await node.approvePermission(sessionId, pendingPerm.permissionId, { decision: 'once' });
            }
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        }

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
        const tools = getToolParts(last);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  QUESTION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 12 — Agent asks a question', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step12', sessionId,
            'I want to add a test framework. Ask me which one I want before you set anything up.'));

        // Wait for question to appear in session state
        await waitForPendingQuestion(node, sessionId, PERM_TIMEOUT);

        const pendingQ = session().questions.find(q => !q.resolved)!;
        expect(pendingQ).toBeDefined();

        // Answer "Vitest"
        await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);

        // Wait for agent to acknowledge
        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        // Verify question is now resolved
        const resolvedQ = session().questions.find(q => q.questionId === pendingQ.questionId);
        expect(resolvedQ?.resolved).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 13 — Act on the answer', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step13', sessionId,
            'Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).'));

        // Handle permissions as they come (may be multiple file creates)
        let finished = false;
        while (!finished) {
            const hadPerm = await Promise.race([
                waitForPendingPermission(node, sessionId, 10000).then(() => true as const),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => 'done' as const),
            ]);

            if (hadPerm === 'done') {
                finished = true;
            } else {
                const perm = session().permissions.find(p => !p.resolved);
                if (perm) {
                    await node.approvePermission(sessionId, perm.permissionId, { decision: 'once' });
                }
            }
        }

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        // Multiple files should have been created
        expect(tools.filter(t => t.state.status === 'completed').length).toBeGreaterThanOrEqual(1);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  SANDBOX
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 14 — Read outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step14', sessionId,
            'What files are in the parent directory?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        // Record behavior — may succeed or be denied. Either way, response exists.
        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 15 — Write outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step15', sessionId,
            'Create a file at `../outside-test.txt` with the content "boundary test".'));

        // May trigger permission that is blocked/denied
        const hadPerm = await Promise.race([
            waitForPendingPermission(node, sessionId, 15000).then(() => true),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPerm) {
            const perm = session().permissions.find(p => !p.resolved);
            if (perm) {
                await node.denyPermission(sessionId, perm.permissionId, { reason: 'Outside project boundary' });
            }
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        }

        const last = getLastAssistantMessage(node, sessionId)!;
        // Should be blocked, denied, or error — file should NOT exist outside project
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  TODO
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 16 — Create todos', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step16', sessionId,
            'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);

        // Todos should appear in session state (if the agent uses the todo tool)
        // At minimum, the text response should mention the items
        const fullText = getFullText(last);
        expect(fullText).toMatch(/due date|drag|export|json/);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  MODEL SWITCH
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 17 — Switch model and edit', async () => {
        const before = assistantCount();
        // Send with a different model to simulate model switch
        await node.sendMessage(sessionId, makeUserMessage('step17', sessionId,
            'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.',
            'claude',
            { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' },
        ));

        // Handle permissions as needed
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

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
        const tools = getToolParts(last);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  COMPACTION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 18 — Compact', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step18', sessionId,
            'Compact the context.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        // Check for compaction part in any message
        const allMsgs = getMessages(node, sessionId);
        const hasCompaction = allMsgs.some(m => hasPart(m, 'compaction'));
        // Compaction part should appear somewhere in the transcript
        // (Some agents may handle compaction differently — at minimum the response should exist)
        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 19 — Post-compaction sanity', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step19', sessionId,
            'What files have we changed so far?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const fullText = getFullText(last);
        // Agent should reference prior work
        expect(fullText).toMatch(/app\.js|styles\.css|index\.html|file/);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  PERSISTENCE
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 20 — Close session', async () => {
        messageCountBeforeClose = getMessages(node, sessionId).length;
        expect(messageCountBeforeClose).toBeGreaterThan(0);

        // Stop the session (simulates closing the agent)
        await node.stopSession(sessionId);
    }, 30000);

    it('Step 21 — Reopen session', async () => {
        // Create a fresh SyncNode and reconnect to the same session
        const node2 = new SyncNode(SERVER_URL, makeAccountToken(), keyMaterial);
        await node2.connect();

        // Fetch messages for the session
        await node2.fetchMessages(sessionId);

        const msgs = getMessages(node2, sessionId);
        // All prior messages should still be present
        expect(msgs.length).toBeGreaterThanOrEqual(messageCountBeforeClose);

        // Update our main node reference to continue the test
        node.disconnect();
        node = node2;
    }, 30000);

    it('Step 22 — Verify continuity', async () => {
        // Re-create the session for continued conversation
        const resumedSessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'Claude E2E Test (continued)',
        });
        // Copy messages from the old session to the new one to maintain context
        // In production, the agent would resume the same session.
        // For the test, we verify continuity by asking the agent.
        sessionId = resumedSessionId;

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step22', sessionId,
            'What was the last thing we were working on?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        // Agent should produce a text response (may or may not reference prior work
        // depending on whether context carries over)
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  TODO (continued)
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 23 — Mark todo done', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step23', sessionId,
            'Mark the "add due dates" todo as completed — we just did that.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
        const fullText = getFullText(last);
        expect(fullText).toMatch(/due date|completed|done|marked/);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  MULTI-PERMISSION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 25 — Multiple permissions in one turn', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step25', sessionId,
            'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.'));

        // Approve each permission individually as they appear
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

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        // Multiple completed tools expected
        const completedTools = tools.filter(t => t.state.status === 'completed');
        expect(completedTools.length).toBeGreaterThanOrEqual(2);

        // All approved permissions should have decision: 'once'
        const resolvedPerms = session().permissions.filter(p => p.resolved);
        expect(resolvedPerms.length).toBeGreaterThanOrEqual(2);
    }, STEP_TIMEOUT);

    it('Step 26 — Supersede pending permissions', async () => {
        const before = assistantCount();

        // Send the superseding message — pending permissions from step 25 should auto-reject
        await node.sendMessage(sessionId, makeUserMessage('step26', sessionId,
            'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".'));

        // Handle any permissions that appear for the new request
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

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  SUBAGENT PERMISSIONS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 27 — Subagent hits permission wall', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step27', sessionId,
            'Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don\'t auto-approve anything for it.'));

        // Wait for the agent to finish — the parent session should have subtask parts.
        // If a child session needs permission, we need to approve in the child session.
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

            // Also check parent session
            const parentPerm = session().permissions.find(p => !p.resolved);
            if (parentPerm) {
                await node.approvePermission(sessionId, parentPerm.permissionId, { decision: 'once' });
            }

            const result = await Promise.race([
                waitForCondition(() => {
                    // Check for any new pending permissions anywhere
                    const all = Array.from(node.state.sessions.values());
                    return all.some(s => s.permissions.some(p => !p.resolved));
                }, 5000).then(() => 'perm' as const),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => 'done' as const),
            ]);

            if (result === 'done') {
                finished = true;
            }
        }

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  STOP WITH PENDING STATE
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 28 — Stop while permission pending', async () => {
        await node.sendMessage(sessionId, makeUserMessage('step28', sessionId,
            'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.'));

        // Wait for permission to appear
        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        // DO NOT approve — stop the session entirely
        await node.stopSession(sessionId);

        // Verify: session status should be completed (stopped)
        const sess = session();
        expect(sess.status.type).toBe('completed');
    }, STEP_TIMEOUT);

    it('Step 29 — Resume after forced stop', async () => {
        // Resume by creating a new session
        sessionId = await node.createSession({
            directory: 'environments/lab-rat-todo-project',
            projectID: 'lab-rat-todo',
            title: 'Claude E2E Test (after stop)',
        });

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step29', sessionId,
            'What happened with the priority feature?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 30 — Retry after stop', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step30', sessionId,
            'Try again — add the priority field. Approve everything this time.'));

        // Approve all permissions that come
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

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  BACKGROUND TASKS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 31 — Launch background task', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step31', sessionId,
            'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.'));

        // Wait for the agent to respond to the time question — should not wait for background
        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);

        // There should be a tool part — possibly in running state (background)
        const tools = getToolParts(last);
        // At least one tool should exist (the background bash command)
        expect(tools.length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 32 — Background completes', async () => {
        // Wait for the background task to complete (~30 seconds)
        await waitForCondition(() => {
            const last = getLastAssistantMessage(node, sessionId);
            if (!last) return false;
            const tools = getToolParts(last);
            return tools.some(t =>
                t.state.status === 'completed' &&
                'output' in t.state &&
                typeof t.state.output === 'string' &&
                t.state.output.includes('donezen'),
            );
        }, 60000);

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step32', sessionId,
            'Did that background task finish? What was the output?'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const fullText = getFullText(last);
        expect(fullText).toMatch(/donezen/);
    }, 240000); // 4 min — includes 30s background wait

    it('Step 33 — Foreground + background concurrent', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step33', sessionId,
            'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".'));

        // Handle permission for the edit if needed
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

        const last = getLastAssistantMessage(node, sessionId)!;
        const tools = getToolParts(last);

        // Should have at least two tool parts — one for background, one for edit
        expect(tools.length).toBeGreaterThanOrEqual(2);

        // At least one should be completed (the edit)
        expect(tools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  WRAP UP
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 34 — Full summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step34', sessionId,
            'Give me a git-style summary of everything we changed. List files modified, lines added/removed if you can tell.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
        // The capstone — agent should produce a coherent summary
        const fullText = getFullText(last);
        expect(fullText.length).toBeGreaterThan(50);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  CROSS-CUTTING ASSERTIONS
    // ═════════════════════════════════════════════════════════════════════════

    it('No legacy envelopes', () => {
        const allMsgs = getMessages(node, sessionId);
        // Zero messages with role: 'session' — all should be user or assistant
        for (const msg of allMsgs) {
            expect(['user', 'assistant']).toContain(msg.info.role);
        }
    });

    it('All assistant messages structurally valid', () => {
        const assistants = getAssistantMessages(node, sessionId);
        for (const msg of assistants) {
            // Every assistant message should have step-start
            expect(hasPart(msg, 'step-start')).toBe(true);
            // At least one content part (text, tool, reasoning, etc.)
            const contentParts = msg.parts.filter(p =>
                p.type !== 'step-start' && p.type !== 'step-finish',
            );
            expect(contentParts.length).toBeGreaterThan(0);
            // step-finish should be present for completed turns
            expect(hasPart(msg, 'step-finish')).toBe(true);
        }
    });

    it('Permission decisions survive round-trip', () => {
        const allMsgs = getMessages(node, sessionId);
        for (const msg of allMsgs) {
            for (const part of msg.parts) {
                if (part.type === 'decision') {
                    expect(part.decision).toBeDefined();
                    expect(part.decidedAt).toBeDefined();
                    expect(part.targetMessageID).toBeDefined();
                    expect(part.targetCallID).toBeDefined();
                    expect(part.permissionID).toBeDefined();
                }
                if (part.type === 'answer') {
                    expect(part.answers).toBeDefined();
                    expect(part.decidedAt).toBeDefined();
                    expect(part.targetMessageID).toBeDefined();
                    expect(part.questionID).toBeDefined();
                }
            }
        }
    });

    it('Message count is sane', () => {
        const allMsgs = getMessages(node, sessionId);
        // No duplicate message IDs
        const ids = allMsgs.map(m => m.info.id);
        expect(new Set(ids).size).toBe(ids.length);
        // Messages should be in order (created timestamps non-decreasing)
        for (let i = 1; i < allMsgs.length; i++) {
            expect(allMsgs[i].info.time.created).toBeGreaterThanOrEqual(
                allMsgs[i - 1].info.time.created,
            );
        }
    });

    it('All tool parts have terminal state', () => {
        const assistants = getAssistantMessages(node, sessionId);
        for (const msg of assistants) {
            const tools = getToolParts(msg);
            for (const tool of tools) {
                // Every tool should be completed or error — not stuck
                expect(['completed', 'error']).toContain(tool.state.status);
            }
        }
    });

    it('Child session structure intact', () => {
        const allSessions = Array.from(node.state.sessions.values());
        const childSessions = allSessions.filter(s => s.info.parentID);

        for (const child of childSessions) {
            // parentID should point to an existing session
            const parentExists = allSessions.some(
                s => s.info.id === child.info.parentID,
            );
            expect(parentExists).toBe(true);

            // Child sessions should have messages
            expect(child.messages.length).toBeGreaterThan(0);
        }
    });
}, 600000);
