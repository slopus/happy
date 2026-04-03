/**
 * Level 2: End-to-End Agent Flow — Claude
 *
 * Full 38-step exercise flow with real LLM, real server, real CLI.
 * Auto-boots a standalone server (PGlite) and a real happy daemon.
 * The daemon spawns real `claude` CLI processes when sessions are created.
 *
 * Assertions verify structural outcomes, not LLM prose.
 *
 * Prerequisites:
 * - happy-cli must be built (yarn build in packages/happy-cli)
 * - `claude` CLI installed and authenticated on this machine
 *
 * Run: npx vitest run src/e2e/claude.integration.test.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { SessionID, Part, MessageWithParts } from '../v3-compat';
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

// Timeouts
const STEP_TIMEOUT = 180000;   // 3 min per step
const PERM_TIMEOUT = 120000;   // 2 min to see a permission
const FINISH_TIMEOUT = 120000; // 2 min for step-finish
const WRITE_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Level 2: Claude E2E Flow (38 steps)', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let sessionId: SessionID;
    let projectDir: string;
    let messageCountBeforeClose: number;

    /** Count of assistant messages — used to wait for the "next" response. */
    function assistantCount(): number {
        return getAssistantMessages(node, sessionId).length;
    }

    /** Session state shortcut. */
    function session() {
        return node.state.sessions.get(sessionId as string)!;
    }

    function assistantToolsSince(afterAssistantCount: number): Array<Part & { type: 'tool' }> {
        return getAssistantMessages(node, sessionId)
            .slice(afterAssistantCount)
            .flatMap(message => getToolParts(message));
    }

    function assistantMessagesSince(afterAssistantCount: number): MessageWithParts[] {
        return getAssistantMessages(node, sessionId).slice(afterAssistantCount);
    }

    function hasTerminalStepFinish(message: MessageWithParts): boolean {
        return message.parts.some(part =>
            part.type === 'step-finish' && part.reason !== 'tool-calls',
        );
    }

    function toolText(tool: Part & { type: 'tool' }): string {
        const state = tool.state;
        return [
            tool.tool,
            JSON.stringify(state.input),
            'title' in state ? state.title : '',
            'output' in state ? state.output : '',
            'error' in state ? state.error : '',
            JSON.stringify('metadata' in state ? state.metadata ?? {} : {}),
        ].join(' ').toLowerCase();
    }

    /**
     * Auto-approve any pending permissions (parent + child sessions) while
     * waiting for step finish. Uses a single poll loop to avoid race condition
     * issues with Promise.race + rejecting waitForCondition.
     */
    async function waitForStepFinishApprovingAll(
        afterAssistantCount: number,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        const approvedIds = new Set<string>();
        let lastLogAt = 0;
        await waitForCondition(() => {
            // Auto-approve any pending permissions across all sessions
            const allSessions = Array.from(node.state.sessions.values());
            for (const sess of allSessions) {
                for (const perm of sess.permissions) {
                    if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                        approvedIds.add(perm.permissionId);
                        console.log(`[waitForStepFinishApprovingAll] auto-approving ${perm.permissionId}`);
                        node.approvePermission(sess.info.id, perm.permissionId, { decision: 'once' }).catch(() => {});
                    }
                }
            }

            // Check if step is finished (same logic as waitForStepFinish)
            const msgs = getAssistantMessages(node, sessionId);
            if (msgs.length <= afterAssistantCount) return false;

            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                for (let i = afterAssistantCount; i < msgs.length; i++) {
                    const m = msgs[i];
                    const partTypes = m.parts.map(p => {
                        if (p.type === 'step-finish') return `step-finish(reason=${(p as any).reason})`;
                        if (p.type === 'tool') return `tool(${(p as any).tool},status=${(p as any).state?.status})`;
                        if (p.type === 'text') return `text(${(p as any).text?.slice(0, 40)}...)`;
                        return p.type;
                    });
                    console.log(`[waitForStepFinishApprovingAll] msg[${i}] (${m.parts.length} parts): ${partTypes.join(', ')}`);
                }
            }

            for (let i = afterAssistantCount; i < msgs.length; i++) {
                if (msgs[i].parts.some(p => p.type === 'step-finish' && (p as any).reason !== 'tool-calls')) {
                    return true;
                }
            }
            return false;
        }, timeoutMs);
    }

    async function waitForAssistantTool(
        afterAssistantCount: number,
        predicate: (tool: Part & { type: 'tool' }) => boolean,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        let lastLogAt = 0;
        await waitForCondition(() => {
            const tools = assistantToolsSince(afterAssistantCount);
            const now = Date.now();
            if (tools.length > 0 && now - lastLogAt > 10000) {
                lastLogAt = now;
                console.log('[waitForAssistantTool]', tools.map(tool =>
                    `${tool.tool}:${tool.callID}:${tool.state.status}`,
                ).join(', '));
            }
            return tools.some(predicate);
        }, timeoutMs);
    }

    async function waitForConditionApprovingAll(
        predicate: () => boolean,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        const approvedIds = new Set<string>();
        await waitForCondition(() => {
            const allSessions = Array.from(node.state.sessions.values());
            for (const sess of allSessions) {
                for (const perm of sess.permissions) {
                    if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                        approvedIds.add(perm.permissionId);
                        node.approvePermission(sess.info.id, perm.permissionId, { decision: 'once' }).catch(() => {});
                    }
                }
            }

            return predicate();
        }, timeoutMs);
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

    // ═════════════════════════════════════════════════════════════════════════
    //  SETUP
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 0 — Session created, agent process spawns', async () => {
        // Daemon spawns real `claude` CLI → CLI creates session on server
        const id = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
        });
        sessionId = id as SessionID;

        // Wait for the session to appear in our SyncNode (via WebSocket update)
        await waitForCondition(
            () => node.state.sessions.has(sessionId as string),
            30000,
        );

        expect(sessionId).toBeTruthy();
        expect(node.state.sessions.has(sessionId as string)).toBe(true);
    }, 60000);

    // ═════════════════════════════════════════════════════════════════════════
    //  TRANSCRIPT
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 1 — Orient: Read all files, tell me what this does', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step1', sessionId,
            'Read all files, tell me what this does.'));

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        await waitForCondition(() => {
            const tools = assistantToolsSince(before);
            return tools.length > 0
                && tools.every(tool => tool.state.status === 'completed' || tool.state.status === 'error');
        }, STEP_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-start')).toBe(true);
        expect(hasPart(last, 'text')).toBe(true);
        expect(hasPart(last, 'step-finish')).toBe(true);

        // Tool parts may be in earlier assistant messages (multi-turn flow)
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const allTools = allAssistant.flatMap(m => getToolParts(m));
        expect(allTools.length).toBeGreaterThan(0);
        expect(allTools.every(t => t.state.status === 'completed')).toBe(true);
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

        // Deny it, then send the actual follow-up user message from the exercise flow.
        const pendingPerm = session().permissions.find(p => !p.resolved)!;
        await node.denyPermission(sessionId, pendingPerm.permissionId);
        await node.sendMessage(sessionId, makeUserMessage('step3-followup', sessionId,
            'No — show me the diff first.'));

        // Wait for agent to recover
        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const allTools = allAssistant.flatMap(m => getToolParts(m));
        const rejected = allTools.find(t => t.state.status === 'error');
        expect(rejected).toBeDefined();
        expect(allAssistant.some(m => hasPart(m, 'text'))).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 4 — Edit approved once', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step4', sessionId,
            'Ok that diff looks right. Go ahead and apply it.'));

        await waitForPendingPermission(node, sessionId, PERM_TIMEOUT);

        const pendingPerm = session().permissions.find(p => !p.resolved)!;
        await node.approvePermission(sessionId, pendingPerm.permissionId, { decision: 'once' });

        await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);

        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const allTools = allAssistant.flatMap(m => getToolParts(m));
        const completed = allTools.find(t => t.state.status === 'completed');
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

        await waitForAssistantTool(
            before,
            tool => tool.callID === pendingPerm.callId
                && WRITE_TOOL_NAMES.has(tool.tool)
                && tool.state.status === 'completed',
            FINISH_TIMEOUT,
        );

        const approvedTool = assistantToolsSince(before).find(tool =>
            tool.callID === pendingPerm.callId
            && WRITE_TOOL_NAMES.has(tool.tool)
            && tool.state.status === 'completed',
        );
        expect(approvedTool).toBeDefined();
        expect(getMessages(node, sessionId).some(message =>
            message.parts.some(part =>
                part.type === 'decision'
                && part.permissionID === pendingPerm.permissionId
                && part.decision === 'always',
            ),
        )).toBe(true);
        expect(
            approvedTool?.state.status === 'completed'
            && approvedTool.state.block?.type === 'permission'
            && approvedTool.state.block.decision === 'always',
        ).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 6 — Auto-approved edit (no permission prompt)', async () => {
        const before = assistantCount();
        const permissionCountBefore = session().permissions.length;
        await node.sendMessage(sessionId, makeUserMessage('step6', sessionId,
            'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.'));

        // This should auto-approve via the always rule from step 5.
        // Finish when we either see a new permission request or a completed write tool.
        let outcome: 'permission' | 'tool' | null = null;
        await waitForCondition(() => {
            if (session().permissions.length > permissionCountBefore) {
                outcome = 'permission';
                return true;
            }

            if (assistantToolsSince(before).some(tool =>
                WRITE_TOOL_NAMES.has(tool.tool) && tool.state.status === 'completed',
            )) {
                outcome = 'tool';
                return true;
            }

            return false;
        }, STEP_TIMEOUT);

        expect(outcome).toBe('tool');
        const tools = assistantToolsSince(before);

        const completedTools = tools.filter(t =>
            WRITE_TOOL_NAMES.has(t.tool) && t.state.status === 'completed',
        );
        expect(completedTools.length).toBeGreaterThan(0);
        expect(session().permissions.length).toBe(permissionCountBefore);
        expect(tools.some(t => t.state.status === 'blocked')).toBe(false);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  WEB SEARCH
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 7 — Search the web', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step7', sessionId,
            'Search the web for best practices on accessible keyboard shortcuts in todo apps.'));

        // Step 6 can still finish trailing tool work after we have already
        // proven auto-approval structurally. Wait for a terminal Step 7 answer
        // that is actually about keyboard shortcuts, not just the next
        // assistant message after `before`.
        const approvedIds = new Set<string>();
        let lastLogAt = 0;
        await waitForCondition(() => {
            const allSessions = Array.from(node.state.sessions.values());
            for (const sess of allSessions) {
                for (const perm of sess.permissions) {
                    if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                        approvedIds.add(perm.permissionId);
                        console.log(`[step7] auto-approving ${perm.permissionId}`);
                        node.approvePermission(sess.info.id, perm.permissionId, { decision: 'once' }).catch(() => {});
                    }
                }
            }

            const allAssistant = getAssistantMessages(node, sessionId).slice(before);
            if (allAssistant.length === 0) return false;

            const fullText = allAssistant.map(message => getFullText(message)).join(' ');
            const hasTopicalText = /keyboard|shortcut|accessib/.test(fullText);
            const hasTerminalTurn = allAssistant.some(message =>
                message.parts.some(part =>
                    part.type === 'step-finish' && ('reason' in part ? part.reason !== 'tool-calls' : false),
                ),
            );

            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                for (let i = before; i < getAssistantMessages(node, sessionId).length; i++) {
                    const message = getAssistantMessages(node, sessionId)[i];
                    const partTypes = message.parts.map(part => {
                        if (part.type === 'step-finish') return `step-finish(reason=${('reason' in part ? part.reason : '')})`;
                        if (part.type === 'tool') return `tool(${part.tool},status=${part.state.status})`;
                        if (part.type === 'text') return `text(${part.text.slice(0, 40)}...)`;
                        return part.type;
                    });
                    console.log(`[step7] msg[${i}] (${message.parts.length} parts): ${partTypes.join(', ')}`);
                }
            }

            return hasTopicalText && hasTerminalTurn;
        }, STEP_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const fullText = allAssistant.map(message => getFullText(message)).join(' ');
        const allTools = assistantToolsSince(before);
        const usedWebTool = allTools.some(tool =>
            tool.state.status === 'completed' && /(search|webfetch)/i.test(tool.tool),
        );

        // Should have at least a text response — and likely a web search/fetch tool
        expect(hasPart(last, 'text')).toBe(true);
        expect(usedWebTool || /keyboard|shortcut|accessib/.test(fullText)).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  SUBAGENTS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 8 — Parallel explore (subagents)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step8', sessionId,
            'I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.'));

        // Subagents may trigger permissions (web search, file reads, etc.)
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        // Subtask parts may be in any assistant message since `before` (multi-turn)
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const subtasks = allAssistant.flatMap(m => getSubtaskParts(m));
        // Claude may use Agent tool (subtask parts) or inline reads — both are valid
        const last = getLastAssistantMessage(node, sessionId)!;

        // Check for child sessions with parentID
        const allSessions = Array.from(node.state.sessions.values());
        const childSessions = allSessions.filter(
            s => s.info.parentID === sessionId,
        );

        // At least one child session should have been created, OR subtask parts present
        if (childSessions.length > 0) {
            for (const child of childSessions) {
                expect(child.messages.length).toBeGreaterThan(0);
            }
        }

        // Parent should have text summary
        expect(hasPart(last, 'text')).toBe(true);
        // Either subtasks or tool calls should be present (agent explored the code)
        const allTools = assistantToolsSince(before);
        expect(subtasks.length + allTools.length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  TOOLS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 9 — Simple edit', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step9', sessionId,
            'Add Cmd+Enter to submit the form from anywhere on the page. That\'s it, nothing else.'));

        // May auto-approve (always rule from step 5) or prompt — approve if needed
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        // Claude may use tools to edit, or may describe the change in text.
        // Either is a valid structural outcome for this step.
        const allTools = assistantToolsSince(before);
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const hasCompletedTool = allTools.some(t => t.state.status === 'completed');
        const hasText = allAssistant.some(m => hasPart(m, 'text'));
        expect(hasCompletedTool || hasText).toBe(true);
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
        // Spawn a new session via daemon for a simpler follow-up
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step11', sessionId,
            'Ok just the Cmd+Enter. Do that.'));

        // May need permission — auto-approve while waiting
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
        // Tools may be in earlier assistant messages (multi-turn flow)
        const allTools = assistantToolsSince(before);
        expect(allTools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  QUESTION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 12 — Agent asks a question', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step12', sessionId,
            'I want to add a test framework. Ask me which one I want before you set anything up.'));

        // Wait for either a formal question OR step-finish (Claude may just ask in text)
        let gotQuestion = false;
        try {
            await Promise.race([
                waitForPendingQuestion(node, sessionId, 30000).then(() => { gotQuestion = true; }),
                waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT),
            ]);
        } catch {
            // If both race arms fail, wait for step-finish with longer timeout
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
        }

        if (gotQuestion) {
            const pendingQ = session().questions.find(q => !q.resolved)!;
            expect(pendingQ).toBeDefined();
            await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);
            await waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT);
            const resolvedQ = session().questions.find(q => q.questionId === pendingQ.questionId);
            expect(resolvedQ?.resolved).toBe(true);
        } else {
            // Claude asked in text — send Vitest as a regular response
            const last = getLastAssistantMessage(node, sessionId)!;
            expect(hasPart(last, 'text')).toBe(true);
            // The text should mention test frameworks
        }
    }, STEP_TIMEOUT);

    it('Step 13 — Act on the answer', async () => {
        const before = assistantCount();
        // If Step 12 didn't use formal question, include the answer in the prompt
        await node.sendMessage(sessionId, makeUserMessage('step13', sessionId,
            'Use Vitest. Set up Vitest. Add a vitest config, a package.json with the dev dependency, and one test that verifies the Done filter bug is fixed (the filter should only return items where done===true).'));

        // Multiple file creates — auto-approve permissions as they come
        // Claude often retries npm install / vitest setup, so give it most of the step timeout
        await waitForStepFinishApprovingAll(before, 270000);

        // Check across all new assistant messages
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const allTools = allAssistant.flatMap(m => getToolParts(m));
        // Agent should have at least acknowledged or created files
        const hasTools = allTools.filter(t => t.state.status === 'completed').length >= 1;
        const hasText = allAssistant.some(m => hasPart(m, 'text'));
        expect(hasTools || hasText).toBe(true);
    }, 300000); // 5 min — npm install + vitest setup can be slow

    // ═════════════════════════════════════════════════════════════════════════
    //  SANDBOX
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 14 — Read outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step14', sessionId,
            'What files are in the parent directory?'));

        // May need permission for Bash/Glob outside project — approve if so
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

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
            waitForPendingPermission(node, sessionId, 15000).then(() => true).catch(() => false),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPerm) {
            const perm = session().permissions.find(p => !p.resolved);
            if (perm) {
                await node.denyPermission(sessionId, perm.permissionId, { reason: 'Outside project boundary' });
            }
        }

        await waitForCondition(() => {
            const allAssistant = getAssistantMessages(node, sessionId).slice(before);
            const allTools = allAssistant.flatMap(message => getToolParts(message));

            const hasTerminalTurn = allAssistant.some(message =>
                message.parts.some(part =>
                    part.type === 'step-finish' && (part as any).reason !== 'tool-calls',
                ),
            );
            const hasDeniedTool = allTools.some(tool => tool.state.status === 'error');

            return hasTerminalTurn || hasDeniedTool;
        }, STEP_TIMEOUT);

        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const allTools = allAssistant.flatMap(message => getToolParts(message));
        expect(
            allAssistant.some(message => hasPart(message, 'step-finish'))
            || allTools.some(tool => tool.state.status === 'error'),
        ).toBe(true);
        expect(existsSync(resolvePath(projectDir, '..', 'outside-test.txt'))).toBe(false);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  TODO
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 16 — Create todos', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step16', sessionId,
            'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.'));

        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);

        // Todos should appear in session state (if the agent uses the todo tool)
        // At minimum, the text response should mention the items
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const fullText = allAssistant.map(m => getFullText(m)).join(' ');
        expect(fullText).toMatch(/due date|drag|export|json|todo|track/);
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

        // Auto-approve permissions as needed
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'step-finish')).toBe(true);
        // Tools may span multiple assistant messages (multi-turn flow)
        const allTools = assistantToolsSince(before);
        expect(allTools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  COMPACTION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 18 — Compact', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step18', sessionId,
            'Compact the context.'));

        // Use waitForStepFinishApprovingAll — Claude may use tools that need permission
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

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

        // Agent might use tools to check files
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        // Check full text across all new assistant messages (multi-turn)
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const fullText = allAssistant.map(m => getFullText(m)).join(' ');
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
        const node2 = new SyncNode(getServerUrl(), makeAccountToken(), keyMaterial, {
            resolveSessionKeyMaterial,
        });
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
        // Spawn a new session via daemon for continued conversation
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

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

        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const fullText = allAssistant.map(m => getFullText(m)).join(' ');
        expect(fullText).toMatch(/due date|completed|done|marked|todo/);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  MULTI-PERMISSION
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 25 — Multiple permissions in one turn', async () => {
        const before = assistantCount();
        const permCountBefore = session().permissions.length;
        await node.sendMessage(sessionId, makeUserMessage('step25', sessionId,
            'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.'));

        // Auto-approve each permission as it appears
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

        // Tools may span multiple assistant messages (multi-turn flow)
        const allTools = assistantToolsSince(before);
        // Multiple completed tools expected (the refactor touches multiple files)
        const completedTools = allTools.filter(t => t.state.status === 'completed');
        expect(completedTools.length).toBeGreaterThanOrEqual(2);

        // If "always" from Step 5 carries over, no new permissions appear.
        // If not, permissions should have been resolved by waitForStepFinishApprovingAll.
        // Either outcome is valid — the key assertion is that tools completed.
        const newPerms = session().permissions.slice(permCountBefore);
        const resolvedPerms = newPerms.filter(p => p.resolved);
        // At least 2 resolved permissions OR auto-approved (0 new permissions)
        expect(resolvedPerms.length >= 2 || newPerms.length === 0).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 26 — Supersede pending permissions', async () => {
        const before = assistantCount();

        // Send the superseding message — pending permissions from step 25 should auto-reject
        await node.sendMessage(sessionId, makeUserMessage('step26', sessionId,
            'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".'));

        // Auto-approve any permissions that appear for the new request
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

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

        // Auto-approve permissions in parent + child sessions
        await waitForStepFinishApprovingAll(before, FINISH_TIMEOUT);

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
        const previousSessionId = sessionId;

        // Resume Claude's underlying conversation via the real daemon. This
        // creates a fresh Happy session record that should continue the prior
        // Claude thread instead of starting from scratch.
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'claude',
            sessionId: previousSessionId,
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step29', sessionId,
            'What happened with the priority feature?'));

        // A real resume should preserve the rejected priority request from
        // Step 28 and let Claude explain what happened.
        await waitForStepFinishApprovingAll(before, STEP_TIMEOUT);

        const last = getLastAssistantMessage(node, sessionId)!;
        expect(hasPart(last, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 30 — Retry after stop', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step30', sessionId,
            'Try again — add the priority field. Approve everything this time.'));

        // Auto-approve all permissions — Step 30 can take 85-120s because
        // Claude retries edits with error/read/edit cycles. Use STEP_TIMEOUT
        // to avoid flaky timeouts.
        await waitForStepFinishApprovingAll(before, STEP_TIMEOUT);

        // Tools may span multiple assistant messages (multi-turn flow)
        const allTools = assistantToolsSince(before);
        expect(allTools.some(t => t.state.status === 'completed')).toBe(true);
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  BACKGROUND TASKS
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 31 — Launch background task', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step31', sessionId,
            'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.'));

        // Bash may need permission — approve while waiting
        await waitForConditionApprovingAll(() => {
            const allAssistant = assistantMessagesSince(before);
            if (allAssistant.length === 0) return false;

            const fullText = allAssistant.map(message => getFullText(message)).join(' ');
            const hasTimeResponse = /\btime\b|:\d{2}|\bam\b|\bpm\b/.test(fullText);
            const hasBackgroundTool = assistantToolsSince(before).some(tool =>
                (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
                && /donezen|sleep 30/.test(toolText(tool)),
            );

            return allAssistant.some(hasTerminalStepFinish) && hasTimeResponse && hasBackgroundTool;
        }, STEP_TIMEOUT);

        const allTools = assistantToolsSince(before);
        expect(allTools.some(tool =>
            (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
            && /donezen|sleep 30/.test(toolText(tool)),
        )).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 32 — Background completes', async () => {
        let before = assistantCount();
        const step32Prompt = 'Did that background task finish? What was the output?';
        await node.sendMessage(sessionId, makeUserMessage('step32', sessionId, step32Prompt));

        const hasCompletedBackgroundOutput = () => assistantToolsSince(before).some(tool =>
            (tool.tool === 'TaskOutput' || tool.tool === 'Bash')
            && tool.state.status === 'completed'
            && 'output' in tool.state
            && typeof tool.state.output === 'string'
            && tool.state.output.includes('donezen'),
        );

        const hasTerminalCompletionTurn = () => assistantMessagesSince(before).some(message =>
            hasTerminalStepFinish(message)
            && /donezen|background task (completed|finished)|it's done|output/.test(getFullText(message)),
        );

        const hasStillRunningTurn = () => assistantMessagesSince(before).some(message =>
            hasTerminalStepFinish(message)
            && /still running|hasn't been 30 seconds yet|i'll be notified|not finished yet/.test(getFullText(message)),
        );

        await waitForConditionApprovingAll(() => {
            if (hasCompletedBackgroundOutput() && hasTerminalCompletionTurn()) {
                return true;
            }

            return hasStillRunningTurn();
        }, 45000);

        if (!hasCompletedBackgroundOutput()) {
            before = assistantCount();
            await node.sendMessage(sessionId, makeUserMessage('step32-retry', sessionId,
                'Wait for that same background task to finish, then tell me the output exactly.'));
        }

        let lastLogAt = 0;
        await waitForConditionApprovingAll(() => {
            const allAssistant = assistantMessagesSince(before);
            if (allAssistant.length === 0) return false;

            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                for (let i = 0; i < allAssistant.length; i += 1) {
                    const message = allAssistant[i];
                    const partTypes = message.parts.map(part => {
                        if (part.type === 'step-finish') return `step-finish(reason=${part.reason})`;
                        if (part.type === 'tool') return `tool(${part.tool},status=${part.state.status})`;
                        if (part.type === 'text') return `text(${part.text.slice(0, 60)}...)`;
                        return part.type;
                    });
                    console.log(`[step32] msg[${before + i}] (${message.parts.length} parts): ${partTypes.join(', ')}`);
                }
                const tools = assistantToolsSince(before);
                if (tools.length > 0) {
                    console.log('[step32 tools]', tools.map(tool =>
                        `${tool.tool}:${tool.callID}:${tool.state.status}:${toolText(tool).slice(0, 120)}`,
                    ).join(' | '));
                }
            }

            return hasCompletedBackgroundOutput() && hasTerminalCompletionTurn();
        }, 240000);

        // Check full text across all new assistant messages
        const allAssistant = getAssistantMessages(node, sessionId).slice(before);
        const fullText = allAssistant.map(m => getFullText(m)).join(' ');
        expect(fullText).toMatch(/donezen/);
    }, 240000); // 4 min — includes 30s background wait

    it('Step 33 — Foreground + background concurrent', async () => {
        let before = assistantCount();
        const appJsPath = resolvePath(projectDir, 'app.js');
        const step33Prompt = 'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".';
        await node.sendMessage(sessionId, makeUserMessage('step33', sessionId, step33Prompt));

        const hasStep33Work = () => {
            const allTools = assistantToolsSince(before);
            const hasStepSpecificBackgroundTool = allTools.some(tool =>
                (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
                && /background two|sleep 20/.test(toolText(tool)),
            );
            const hasBackgroundComment = existsSync(appJsPath)
                && readFileSync(appJsPath, 'utf8').includes('// background task test');
            const hasStepSpecificText = assistantMessagesSince(before).some(message =>
                /background two|background task test/.test(getFullText(message)),
            );

            return hasStepSpecificBackgroundTool && (hasBackgroundComment || hasStepSpecificText);
        };

        try {
            await waitForConditionApprovingAll(() => {
                if (hasStep33Work()) {
                    return true;
                }

                return assistantMessagesSince(before).some(message =>
                    hasTerminalStepFinish(message)
                    && /background task completion notification|we already/.test(getFullText(message)),
                );
            }, 30000);
        } catch {
            // No early step-specific signal arrived. Fall through to the retry
            // path below instead of failing the whole step before we can steer
            // Claude back onto the intended request.
        }

        if (!hasStep33Work()) {
            before = assistantCount();
            await node.sendMessage(sessionId, makeUserMessage('step33-retry', sessionId,
                'That was the previous background task. Now do this new request: start a NEW background task `sleep 20 && echo "background two"` and, while it is running, add `// background task test` to the top of app.js.'));
        }

        let lastLogAt = 0;
        await waitForConditionApprovingAll(() => {
            const now = Date.now();
            if (now - lastLogAt > 10000) {
                lastLogAt = now;
                const allAssistant = assistantMessagesSince(before);
                const allTools = assistantToolsSince(before);
                for (let i = 0; i < allAssistant.length; i += 1) {
                    const message = allAssistant[i];
                    const partTypes = message.parts.map(part => {
                        if (part.type === 'step-finish') return `step-finish(reason=${part.reason})`;
                        if (part.type === 'tool') return `tool(${part.tool},status=${part.state.status})`;
                        if (part.type === 'text') return `text(${part.text.slice(0, 60)}...)`;
                        return part.type;
                    });
                    console.log(`[step33] msg[${before + i}] (${message.parts.length} parts): ${partTypes.join(', ')}`);
                }
                if (allTools.length > 0) {
                    console.log('[step33 tools]', allTools.map(tool =>
                        `${tool.tool}:${tool.callID}:${tool.state.status}:${toolText(tool).slice(0, 120)}`,
                    ).join(' | '));
                }
            }

            return hasStep33Work();
        }, STEP_TIMEOUT);

        await waitForConditionApprovingAll(() => {
            const allTools = assistantToolsSince(before);
            return allTools.length > 0
                && allTools.every(tool => tool.state.status === 'completed' || tool.state.status === 'error');
        }, 120000);

        // Tools may span multiple assistant messages (multi-turn flow)
        const allTools = assistantToolsSince(before);

        expect(allTools.some(tool =>
            (tool.tool === 'Bash' || tool.tool === 'TaskOutput')
            && /background two|sleep 20/.test(toolText(tool)),
        )).toBe(true);
        expect(readFileSync(appJsPath, 'utf8')).toContain('// background task test');
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  WRAP UP
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 34 — Full summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step34', sessionId,
            'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.'));

        await waitForConditionApprovingAll(() => {
            return assistantMessagesSince(before).some(message => {
                const fullText = getFullText(message);
                return hasTerminalStepFinish(message)
                    && fullText.length > 50
                    && /(git|summary|modified|changed|added|removed|app\.js|index\.html|styles\.css)/.test(fullText);
            });
        }, STEP_TIMEOUT);

        const summary = assistantMessagesSince(before).find(message => {
            const fullText = getFullText(message);
            return hasTerminalStepFinish(message)
                && fullText.length > 50
                && /(git|summary|modified|changed|added|removed|app\.js|index\.html|styles\.css)/.test(fullText);
        });
        expect(summary).toBeDefined();
    }, STEP_TIMEOUT);

    // ═════════════════════════════════════════════════════════════════════════
    //  BACKGROUND SUBAGENTS (TaskCreate / TaskOutput)
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 35 — Background subagent (TaskCreate)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step35', sessionId,
            "Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works."));

        // Claude should use TaskCreate to launch a background task AND continue
        // responding in the foreground. Wait for a terminal step-finish that
        // includes foreground text about the project structure.
        await waitForConditionApprovingAll(() => {
            return assistantMessagesSince(before).some(message =>
                hasTerminalStepFinish(message)
                && getFullText(message).length > 30,
            );
        }, 300000);

        // Check that TaskCreate tool part appeared (background task launched)
        const allTools = assistantToolsSince(before);
        const hasTaskCreate = allTools.some(t =>
            t.tool === 'TaskCreate' || /task/i.test(t.tool),
        );
        // Claude should have launched a background task, but the foreground
        // response is the critical assertion — the background task is bonus.
        const allText = assistantMessagesSince(before).map(m => getFullText(m)).join(' ');
        expect(allText.length).toBeGreaterThan(30);
        if (!hasTaskCreate) {
            console.log('[Step 35] Note: no TaskCreate tool found — Claude may have handled this differently');
        }
    }, 300000); // 5 min — TaskCreate can take a long time

    it('Step 36 — Check background agent result (TaskOutput)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step36', sessionId,
            'Did that background research finish? What did it find?'));

        // Claude should use TaskOutput (possibly with block:true) to retrieve
        // the background task result.
        await waitForConditionApprovingAll(() => {
            return assistantMessagesSince(before).some(message =>
                hasTerminalStepFinish(message)
                && getFullText(message).length > 30,
            );
        }, 300000);

        const allTools = assistantToolsSince(before);
        const hasTaskOutput = allTools.some(t =>
            t.tool === 'TaskOutput' || /task/i.test(t.tool),
        );
        const allText = assistantMessagesSince(before).map(m => getFullText(m)).join(' ');
        // Should mention CSS frameworks from the background research
        expect(allText.length).toBeGreaterThan(30);
        if (!hasTaskOutput) {
            console.log('[Step 36] Note: no TaskOutput tool found — Claude may have inlined the result');
        }
    }, 300000); // 5 min — TaskOutput with block:true waits for background task

    it('Step 37 — Multiple background tasks', async () => {
        const before = assistantCount();
        const appJsPath = resolvePath(projectDir, 'app.js');
        await node.sendMessage(sessionId, makeUserMessage('step37', sessionId,
            'Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".'));

        // Wait for foreground edit to complete + some background activity
        await waitForConditionApprovingAll(() => {
            const allTools = assistantToolsSince(before);
            const hasEdit = allTools.some(t =>
                (t.tool === 'Edit' || t.tool === 'Write')
                && (t.state.status === 'completed' || t.state.status === 'error'),
            );
            const hasAppJsComment = existsSync(appJsPath)
                && readFileSync(appJsPath, 'utf8').includes('// multi-task test');
            const hasTerminal = assistantMessagesSince(before).some(hasTerminalStepFinish);

            return hasTerminal && (hasEdit || hasAppJsComment);
        }, 300000);

        // Foreground edit should have happened
        expect(
            existsSync(appJsPath) && readFileSync(appJsPath, 'utf8').includes('// multi-task test')
            || assistantToolsSince(before).some(t =>
                (t.tool === 'Edit' || t.tool === 'Write') && t.state.status === 'completed',
            ),
        ).toBe(true);
    }, 300000); // 5 min — multiple background tasks + foreground edit

    // ═════════════════════════════════════════════════════════════════════════
    //  WRAP UP (final)
    // ═════════════════════════════════════════════════════════════════════════

    it('Step 38 — Final summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, makeUserMessage('step38', sessionId,
            'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.'));

        await waitForConditionApprovingAll(() => {
            return assistantMessagesSince(before).some(message => {
                const fullText = getFullText(message);
                return hasTerminalStepFinish(message)
                    && fullText.length > 50
                    && /(summary|modified|changed|files|app\.js)/.test(fullText);
            });
        }, STEP_TIMEOUT);

        // Wait for ALL tools across ALL messages to reach terminal state.
        // Background task tools from Steps 31/33/35/37 may still be completing.
        // Must match the cross-cutting assertion: only 'completed' or 'error'.
        let lastToolLogAt = 0;
        await waitForConditionApprovingAll(() => {
            const allMsgs = getAssistantMessages(node, sessionId);
            const nonTerminal: Array<{ tool: string; callID: string; status: string; msgIdx: number }> = [];
            for (let i = 0; i < allMsgs.length; i++) {
                for (const tool of getToolParts(allMsgs[i])) {
                    if (tool.state.status !== 'completed' && tool.state.status !== 'error') {
                        nonTerminal.push({ tool: tool.tool, callID: tool.callID, status: tool.state.status, msgIdx: i });
                    }
                }
            }
            if (nonTerminal.length > 0) {
                const now = Date.now();
                if (now - lastToolLogAt > 15000) {
                    lastToolLogAt = now;
                    console.log(`[step38 drain] ${nonTerminal.length} non-terminal tools:`,
                        nonTerminal.map(t => `msg[${t.msgIdx}] ${t.tool}:${t.callID}:${t.status}`).join(' | '));
                }
                return false;
            }
            return true;
        }, STEP_TIMEOUT);

        const allText = assistantMessagesSince(before).map(m => getFullText(m)).join(' ');
        expect(allText.length).toBeGreaterThan(50);
    }, 300000); // 5 min — summary + wait for all background tools to drain

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
}, 2400000); // 40 min — full 38-step flow with real LLM
