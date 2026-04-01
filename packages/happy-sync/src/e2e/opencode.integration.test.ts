/**
 * Level 2: End-to-End Agent Flow — OpenCode
 *
 * Full 38-step exercise flow via the ACP adapter.
 * Same structure as claude.integration.test.ts.
 *
 * Key difference from Claude: OpenCode uses tools aggressively (even for
 * read-only queries) and those tools require permissions. Almost every step
 * needs permission auto-approval to complete.
 *
 * Run: npx vitest run src/e2e/opencode.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { SyncNode } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { SessionID, Part } from '../v3-compat';
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

const OPENCODE_MODEL = { providerID: 'openai', modelID: 'gpt-5.4' };

const STEP_TIMEOUT = 300000;   // 5 min — OpenCode does more tool calls per step
const PERM_TIMEOUT = 120000;
const FINISH_TIMEOUT = 240000; // 4 min — OpenCode ACP turns can be slow
const OPENCODE_SETTLE_GRACE_MS = 3000;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Level 2: OpenCode E2E Flow (38 steps)', () => {
    let node: SyncNode;
    let keyMaterial: KeyMaterial;
    let sessionId: SessionID;
    let projectDir: string;
    let messageCountBeforeClose: number;

    type FamilyAssistantSnapshot = Map<string, number>;

    function assistantCount(): number {
        return getAssistantMessages(node, sessionId).length;
    }

    function assistantMessagesSince(afterAssistantCount: number) {
        return getAssistantMessages(node, sessionId).slice(afterAssistantCount);
    }

    function assistantToolsSince(afterAssistantCount: number) {
        return assistantMessagesSince(afterAssistantCount).flatMap(getToolParts);
    }

    function getSessionFamily(rootSessionId: SessionID) {
        const family = new Map<string, ReturnType<typeof session>>();
        const queue = [rootSessionId as string];

        while (queue.length > 0) {
            const currentId = queue.shift()!;
            if (family.has(currentId)) {
                continue;
            }

            const currentSession = node.state.sessions.get(currentId);
            if (!currentSession) {
                continue;
            }

            family.set(currentId, currentSession);
            for (const candidate of node.state.sessions.values()) {
                if (candidate.info.parentID === currentId && !family.has(candidate.info.id)) {
                    queue.push(candidate.info.id);
                }
            }
        }

        return Array.from(family.values());
    }

    function captureFamilyAssistantSnapshot(rootSessionId: SessionID): FamilyAssistantSnapshot {
        const snapshot = new Map<string, number>();
        for (const sess of getSessionFamily(rootSessionId)) {
            snapshot.set(
                sess.info.id,
                sess.messages.filter(message => message.info.role === 'assistant').length,
            );
        }
        return snapshot;
    }

    function assistantFamilyMessagesSince(
        rootSessionId: SessionID,
        snapshot: FamilyAssistantSnapshot,
    ) {
        return getSessionFamily(rootSessionId).flatMap((sess) => {
            const assistantMessages = sess.messages.filter(message => message.info.role === 'assistant');
            return assistantMessages.slice(snapshot.get(sess.info.id) ?? 0);
        });
    }

    function assistantFamilyToolsSince(
        rootSessionId: SessionID,
        snapshot: FamilyAssistantSnapshot,
    ) {
        return assistantFamilyMessagesSince(rootSessionId, snapshot).flatMap(getToolParts);
    }

    function hasFamilyAssistantActivity(
        rootSessionId: SessionID,
        snapshot: FamilyAssistantSnapshot,
    ): boolean {
        return assistantFamilyMessagesSince(rootSessionId, snapshot).length > 0;
    }

    function hasFamilyTerminalToolOutcome(
        rootSessionId: SessionID,
        snapshot: FamilyAssistantSnapshot,
    ): boolean {
        return assistantFamilyToolsSince(rootSessionId, snapshot).some(
            tool => tool.state.status === 'completed' || tool.state.status === 'error',
        );
    }

    function hasTerminalToolOutcome(afterAssistantCount: number): boolean {
        return assistantToolsSince(afterAssistantCount).some(
            tool => tool.state.status === 'completed' || tool.state.status === 'error',
        );
    }

    function hasResponseSignal(afterAssistantCount: number): boolean {
        return assistantMessagesSince(afterAssistantCount).some(
            message => hasPart(message, 'text') || hasPart(message, 'step-finish'),
        ) || hasTerminalToolOutcome(afterAssistantCount);
    }

    function session() {
        return node.state.sessions.get(sessionId as string)!;
    }

    function findFirstPendingPermission() {
        for (const sess of node.state.sessions.values()) {
            const permission = sess.permissions.find(p => !p.resolved);
            if (permission) {
                return { sessionId: sess.info.id, permission };
            }
        }
        return null;
    }

    function approveAllPendingPermissions(
        approvedIds: Set<string>,
    ): void {
        for (const sess of node.state.sessions.values()) {
            for (const perm of sess.permissions) {
                if (!perm.resolved && !approvedIds.has(perm.permissionId)) {
                    approvedIds.add(perm.permissionId);
                    node.approvePermission(sess.info.id, perm.permissionId, { decision: 'once' }).catch(() => {});
                }
            }
        }
    }

    async function waitForAnyPendingPermission(timeoutMs = PERM_TIMEOUT): Promise<void> {
        await waitForCondition(() => findFirstPendingPermission() !== null, timeoutMs);
    }

    async function waitForPermissionOrSettled(
        afterAssistantCount: number,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<boolean> {
        await waitForCondition(
            () => findFirstPendingPermission() !== null || isOpenCodeTurnSettled(afterAssistantCount),
            timeoutMs,
        );
        return findFirstPendingPermission() !== null;
    }

    function msg(id: string, text: string) {
        return makeUserMessage(id, sessionId, text, 'opencode', OPENCODE_MODEL);
    }

    function isOpenCodeTurnSettled(afterAssistantCount: number): boolean {
        const msgs = assistantMessagesSince(afterAssistantCount);
        if (msgs.length === 0) return false;

        const hasMeaningfulOutput = msgs.some(message =>
            message.parts.some(part => part.type !== 'step-start'),
        );
        if (!hasMeaningfulOutput) return false;

        const hasPendingPermissions = Array.from(node.state.sessions.values()).some(sess =>
            sess.permissions.some(permission => !permission.resolved),
        );
        if (hasPendingPermissions) return false;

        const tools = assistantToolsSince(afterAssistantCount);
        const allToolsTerminal = tools.every(tool =>
            tool.state.status === 'completed' || tool.state.status === 'error',
        );
        const hasCompletedAssistantMessage = msgs.some(
            message => 'completed' in message.info.time && message.info.time.completed !== undefined,
        );

        if (tools.length > 0) {
            if (!allToolsTerminal) return false;
        }

        const hasFinalStepFinish = msgs.some(message =>
            message.parts.some(
                part => part.type === 'step-finish' && part.reason !== 'tool-calls',
            ),
        );
        if (hasFinalStepFinish) return true;

        if (tools.length > 0) {
            return hasCompletedAssistantMessage;
        }

        if (hasCompletedAssistantMessage) {
            return true;
        }

        if (session().status.type !== 'idle') return false;

        return msgs.some(message => hasPart(message, 'text'));
    }

    function getLastMeaningfulAssistantMessage(afterAssistantCount: number) {
        const msgs = assistantMessagesSince(afterAssistantCount);
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].parts.some(part => part.type !== 'step-start')) {
                return msgs[i];
            }
        }
        return undefined;
    }

    /**
     * Get the "response" message: either the one with step-finish, or the last
     * message with text content. OpenCode's ACP turns don't always produce
     * a step-finish part, so this falls back gracefully.
     */
    function getResponseMessage(afterAssistantCount: number) {
        const msgs = assistantMessagesSince(afterAssistantCount);
        // Prefer message with step-finish
        const withFinish = msgs.find(m => hasPart(m, 'step-finish'));
        if (withFinish) return withFinish;
        // Fall back to last message with text
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (hasPart(msgs[i], 'text')) return msgs[i];
        }
        // Fall back to last meaningful message
        return getLastMeaningfulAssistantMessage(afterAssistantCount);
    }

    async function waitForResponseSignal(afterAssistantCount: number, timeoutMs = 30000): Promise<void> {
        await waitForCondition(() => hasResponseSignal(afterAssistantCount), timeoutMs);
    }

    async function waitForResponseText(afterAssistantCount: number, timeoutMs = 30000): Promise<void> {
        await waitForCondition(() => {
            const response = getResponseMessage(afterAssistantCount);
            return response !== undefined && getFullText(response).trim().length > 0;
        }, timeoutMs);
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

    /**
     * Auto-approve ALL pending permissions across ALL sessions (parent + children)
     * and wait for the OpenCode turn to settle on the parent session.
     *
     * OpenCode uses tools aggressively — even "tell me about X" prompts may
     * trigger file reads that require permission. This helper is the workhorse
     * for most steps.
     */
    async function waitForStepFinishApprovingAll(
        afterAssistantCount: number,
        timeoutMs = FINISH_TIMEOUT,
    ): Promise<void> {
        const approvedIds = new Set<string>();
        let lastLogAt = 0;
        let lastFingerprint = '';
        let lastActivityAt = Date.now();
        await waitForCondition(() => {
            // Auto-approve any pending permissions across ALL sessions
            approveAllPendingPermissions(approvedIds);

            // Check if the turn is finished
            const msgs = getAssistantMessages(node, sessionId);
            if (msgs.length <= afterAssistantCount) return false;

            const fingerprint = JSON.stringify(
                msgs.slice(afterAssistantCount).map((message) => ({
                    id: message.info.id,
                    parts: message.parts.map((part) => {
                        if (part.type === 'tool') {
                            return `${part.type}:${part.callID}:${part.state.status}`;
                        }
                        if (part.type === 'step-finish') {
                            return `${part.type}:${part.reason}`;
                        }
                        if (part.type === 'text') {
                            return `${part.type}:${part.text.length}`;
                        }
                        if (part.type === 'reasoning') {
                            return `${part.type}:${part.text.length}`;
                        }
                        return part.type;
                    }),
                })),
            );
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint;
                lastActivityAt = Date.now();
            }

            const now = Date.now();
            if (now - lastLogAt > 15000) {
                lastLogAt = now;
                console.log(`[waitForStepFinishApprovingAll] session status=${session().status.type}`);
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

            if (!isOpenCodeTurnSettled(afterAssistantCount)) {
                return false;
            }

            const settledWithFinish = msgs
                .slice(afterAssistantCount)
                .some(message => hasPart(message, 'step-finish'));
            if (settledWithFinish) {
                return true;
            }

            return now - lastActivityAt >= OPENCODE_SETTLE_GRACE_MS;
        }, timeoutMs);
    }

    /**
     * Wait for the first pending permission, approve with given decision,
     * then auto-approve all remaining permissions until step finishes.
     */
    async function approveFirstThenAll(
        before: number,
        decision: 'once' | 'always',
        allowTools?: string[],
    ): Promise<void> {
        const sawPermission = await waitForPermissionOrSettled(before);

        if (!sawPermission) {
            return;
        }

        const pending = findFirstPendingPermission();
        if (!pending) {
            throw new Error('Expected a pending permission after waitForAnyPendingPermission resolved');
        }

        const { sessionId: permissionSessionId, permission: perm } = pending;
        const opts: any = { decision };
        if (allowTools) opts.allowTools = allowTools;
        await node.approvePermission(permissionSessionId, perm.permissionId, opts);
        await waitForStepFinishApprovingAll(before);
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

    // ─── SETUP ───────────────────────────────────────────────────────────

    it('Step 0 — Session created, agent process spawns', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'opencode',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        expect(sessionId).toBeTruthy();
        expect(node.state.sessions.has(sessionId as string)).toBe(true);
    }, 60000);

    // ─── TRANSCRIPT ──────────────────────────────────────────────────────

    it('Step 1 — Orient', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step1', 'Read all files, tell me what this does.'));

        await waitForStepFinishApprovingAll(before);

        const allSince = assistantMessagesSince(before);
        expect(allSince.length).toBeGreaterThan(0);
        // OpenCode reads files via tools — at minimum we expect tool activity
        expect(
            assistantToolsSince(before).length > 0
            || allSince.some(m => hasPart(m, 'text')),
        ).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 2 — Find the bug', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step2',
            "There's a bug in the Done filter — it shows all items instead of only completed ones. Find it and show me the exact line."));

        await waitForStepFinishApprovingAll(before);

        const allSince = assistantMessagesSince(before);
        expect(allSince.length).toBeGreaterThan(0);
        // Check for text about the bug, or tool output (OpenCode may describe bug inline)
        const allText = allSince.map(m => getFullText(m)).join(' ');
        const toolOutputs = assistantToolsSince(before)
            .map(t => ('output' in t.state && typeof t.state.output === 'string') ? t.state.output : '')
            .join(' ');
        expect(`${allText} ${toolOutputs}`).toMatch(/filter|done|bug|app\.js/i);
    }, STEP_TIMEOUT);

    // ─── PERMISSIONS ─────────────────────────────────────────────────────

    it('Step 3 — Edit rejected', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        await node.sendMessage(sessionId, msg('step3', 'Fix it.'));
        let deniedPermission:
            | { sessionId: SessionID; permissionId: string }
            | null = null;

        // OpenCode may or may not surface a permission request.
        // Race: permission vs step-finish (opencode might auto-approve)
        const hadPerm = await waitForPermissionOrSettled(before);

        if (hadPerm) {
            const pending = findFirstPendingPermission();
            if (!pending) {
                throw new Error('Expected a pending permission after waitForAnyPendingPermission resolved');
            }
            const { sessionId: permissionSessionId, permission: perm } = pending;
            console.log(`[Step 3] Permission tool: ${perm.block.permission}, tool info:`, JSON.stringify(perm.block).slice(0, 200));
            deniedPermission = { sessionId: permissionSessionId as SessionID, permissionId: perm.permissionId };
            await node.denyPermission(permissionSessionId, perm.permissionId, { reason: 'Show me the diff first' });
        }

        let lastLogAt = 0;
        await waitForCondition(
            () => {
                const now = Date.now();
                if (now - lastLogAt > 10000) {
                    lastLogAt = now;
                    const tools = assistantToolsSince(before);
                    console.log(`[Step 3] status=${session().status.type} pendingPerms=${session().permissions.filter(p => !p.resolved).length} tools=${JSON.stringify(tools.map(t => ({ tool: t.tool, status: t.state.status })))}`);
                }
                if (!hadPerm) return isOpenCodeTurnSettled(before);
                return session().status.type === 'idle'
                    && Array.from(node.state.sessions.values()).every(
                        sess => !sess.permissions.some(permission => !permission.resolved),
                    );
            },
            FINISH_TIMEOUT,
        );

        if (hadPerm) {
            // File should remain unmodified since we denied
            expect(readFileSync(`${projectDir}/app.js`, 'utf-8')).toContain(
                'return state.items.filter((item) => item.done === true);',
            );
            expect(
                hasFamilyAssistantActivity(sessionId, familyBefore)
                || hasFamilyTerminalToolOutcome(sessionId, familyBefore),
            ).toBe(true);
        } else {
            // OpenCode may decline to edit and instead answer read-only.
            expect(readFileSync(`${projectDir}/app.js`, 'utf-8')).toContain(
                'return state.items.filter((item) => item.done === true);',
            );
            expect(
                hasFamilyAssistantActivity(sessionId, familyBefore)
                || hasFamilyTerminalToolOutcome(sessionId, familyBefore),
            ).toBe(true);
        }
    }, STEP_TIMEOUT);

    it('Step 4 — Edit approved once', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step4',
            'Apply the Done-filter fix now. Change the filter so it only returns items where `done === true`.'));

        await approveFirstThenAll(before, 'once');

        // OpenCode may have already applied the fix in Step 3 (auto-approved).
        // If so, this step just produces text — no tools needed.
        const tools = assistantToolsSince(before);
        if (tools.length > 0) {
            expect(tools.some(t => t.state.status === 'completed')).toBe(true);
        } else {
            const allSince = assistantMessagesSince(before);
            expect(allSince.some(m => hasPart(m, 'step-finish'))).toBe(true);
        }
    }, STEP_TIMEOUT);

    it('Step 5 — Edit approved always', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const stylesBefore = readFileSync(`${projectDir}/styles.css`, 'utf-8');
        await node.sendMessage(sessionId, msg('step5',
            'Add dark mode support. Use a `prefers-color-scheme: dark` media query in styles.css. Keep it simple — just invert the main colors.'));

        // Race: permission vs auto-completion
        const hadPerm = await waitForPermissionOrSettled(before);

        if (hadPerm) {
            const pending = findFirstPendingPermission();
            if (!pending) {
                throw new Error('Expected a pending permission after waitForAnyPendingPermission resolved');
            }
            const { sessionId: permissionSessionId, permission: perm } = pending;
            await node.approvePermission(permissionSessionId, perm.permissionId, {
                decision: 'always',
                allowTools: [perm.block.permission],
            });
        }

        await waitForStepFinishApprovingAll(before);
        expect(
            hasFamilyTerminalToolOutcome(sessionId, familyBefore)
            || readFileSync(`${projectDir}/styles.css`, 'utf-8') !== stylesBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 6 — Auto-approved edit', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const appBefore = readFileSync(`${projectDir}/app.js`, 'utf-8');
        const indexBefore = readFileSync(`${projectDir}/index.html`, 'utf-8');
        await node.sendMessage(sessionId, msg('step6',
            'Also add a `.dark-toggle` button to the HTML so users can manually switch themes. Put it after the h1 in the hero panel. Wire it up in app.js — toggle a `dark` class on the body.'));

        // The "always" rule from Step 5 should auto-approve edits.
        // But OpenCode may use other tools too — approve those.
        await waitForStepFinishApprovingAll(before);

        expect(
            hasFamilyTerminalToolOutcome(sessionId, familyBefore)
            || readFileSync(`${projectDir}/app.js`, 'utf-8') !== appBefore
            || readFileSync(`${projectDir}/index.html`, 'utf-8') !== indexBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── WEB SEARCH ──────────────────────────────────────────────────────

    it('Step 7 — Search the web', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step7',
            'Search the web for best practices on accessible keyboard shortcuts in todo apps.'));

        await waitForStepFinishApprovingAll(before);

        const allSince = assistantMessagesSince(before);
        const tools = allSince.flatMap(getToolParts);
        // OpenCode may or may not have web search — just verify it responded
        expect(allSince.length).toBeGreaterThan(0);
        expect(
            allSince.some(m => hasPart(m, 'text') || hasPart(m, 'step-finish'))
            || tools.some(tool => tool.state.status === 'completed'),
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── SUBAGENTS ───────────────────────────────────────────────────────

    it('Step 8 — Parallel explore', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step8',
            'I want to add keyboard shortcuts. Before you do anything, use a subagent to explore what keyboard events the app currently handles, and separately check if there are any accessibility issues in the HTML. Do both in parallel.'));

        await waitForStepFinishApprovingAll(before);

        const allSince = assistantMessagesSince(before);
        const tools = allSince.flatMap(getToolParts);
        expect(allSince.length).toBeGreaterThan(0);
        expect(
            allSince.some(m => hasPart(m, 'text') || hasPart(m, 'step-finish'))
            || tools.some(tool => tool.state.status === 'completed'),
        ).toBe(true);

        // Subtask parts are best-effort — OpenCode may or may not use subagents
        const subtasks = allSince.flatMap(getSubtaskParts);
        if (subtasks.length > 0) {
            const childSessions = Array.from(node.state.sessions.values()).filter(
                s => s.info.parentID === sessionId,
            );
            for (const child of childSessions) {
                expect(child.messages.length).toBeGreaterThan(0);
            }
        }
    }, STEP_TIMEOUT);

    // ─── TOOLS ───────────────────────────────────────────────────────────

    it('Step 9 — Simple edit', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const appBefore = readFileSync(`${projectDir}/app.js`, 'utf-8');
        const indexBefore = readFileSync(`${projectDir}/index.html`, 'utf-8');
        await node.sendMessage(sessionId, msg('step9',
            "Add Cmd+Enter to submit the form from anywhere on the page. That's it, nothing else."));

        await waitForStepFinishApprovingAll(before);
        expect(
            hasFamilyTerminalToolOutcome(sessionId, familyBefore)
            || readFileSync(`${projectDir}/app.js`, 'utf-8') !== appBefore
            || readFileSync(`${projectDir}/index.html`, 'utf-8') !== indexBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── INTERRUPTION ────────────────────────────────────────────────────

    it('Step 10 — Cancel mid-stream', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        await node.sendMessage(sessionId, msg('step10',
            'Add keyboard shortcut support — Cmd+Enter to submit from anywhere, Escape to clear the input, arrow keys to navigate todos.'));

        // OpenCode may start work in a child session before the parent emits text.
        await waitForCondition(() => {
            const family = getSessionFamily(sessionId);
            const childSessionCount = family.length;
            const hasPendingPermission = family.some(
                sess => sess.permissions.some(permission => !permission.resolved),
            );
            return hasFamilyAssistantActivity(sessionId, familyBefore)
                || childSessionCount > familyBefore.size
                || hasPendingPermission;
        }, 30000);

        await node.stopSession(sessionId);
        expect(session().status.type).toBe('completed');
        expect(
            hasFamilyAssistantActivity(sessionId, familyBefore)
            || getSessionFamily(sessionId).length > familyBefore.size,
        ).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 11 — Resume after cancel', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'opencode',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step11', 'Ok just the Cmd+Enter. Do that.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseSignal(before);
        const allSince = assistantMessagesSince(before);
        // OpenCode may or may not produce a step-finish — just verify we got a response
        expect(allSince.length).toBeGreaterThan(0);
        expect(hasResponseSignal(before)).toBe(true);
    }, STEP_TIMEOUT);

    // ─── QUESTION ────────────────────────────────────────────────────────

    it('Step 12 — Agent asks a question', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step12',
            'I want to add a test framework. Ask me which one I want before you set anything up.'));

        // OpenCode may or may not use formal AskUserQuestion.
        // Try to wait for a pending question; fall back to step-finish.
        let answered = false;
        try {
            await waitForPendingQuestion(node, sessionId, 30000);
            const pendingQ = session().questions.find(q => !q.resolved);
            if (pendingQ) {
                await node.answerQuestion(sessionId, pendingQ.questionId, [['Vitest']]);
                answered = true;
            }
        } catch {
            // No formal question — OpenCode listed options in text instead
        }

        await waitForStepFinishApprovingAll(before);

        if (answered) {
            const pendingQ = session().questions.find(q => q.resolved);
            expect(pendingQ?.resolved).toBe(true);
        }

        const allSince = assistantMessagesSince(before);
        expect(allSince.some(m => hasPart(m, 'text') || hasPart(m, 'step-finish'))).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 13 — Act on the answer', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step13',
            'Create the Vitest setup files. Write vitest.config.js, a test file (e.g. app.test.js) that verifies the Done filter only returns items where done===true, and add vitest to package.json devDependencies. Do NOT run npm install or run the tests — just create the files.'));

        await waitForStepFinishApprovingAll(before, 270000);

        const filesExist = () => {
            const files = listProjectFiles(projectDir);
            const hasVitestConfig = files.some(file =>
                /^vitest\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(file),
            );
            const hasTestFile = files.some(file =>
                /(^|\/).+\.(test|spec)\.(js|jsx|ts|tsx|cjs|mjs)$/.test(file),
            );
            const packageJsonPath = `${projectDir}/package.json`;
            const hasVitestPackageJson = existsSync(packageJsonPath)
                && readFileSync(packageJsonPath, 'utf-8').includes('vitest');
            return hasVitestConfig && hasTestFile && hasVitestPackageJson;
        };

        let created = false;
        try {
            await waitForCondition(filesExist, 30000);
            created = true;
        } catch {
            console.log('[Step 13] Files not created after first turn, sending follow-up');
            const beforeFollowUp = assistantCount();
            await node.sendMessage(sessionId, msg('step13b',
                'Just write the files now — vitest.config.js, app.test.js, and update package.json. Do NOT run npm install.'));
            await waitForStepFinishApprovingAll(beforeFollowUp, 270000);
            await waitForCondition(filesExist, 30000);
            created = true;
        }

        expect(created).toBe(true);
        const files = listProjectFiles(projectDir);
        expect(files.some(file => /^vitest\.config\.(js|cjs|mjs|ts|cts|mts)$/.test(file))).toBe(true);
        expect(files.some(file => /(^|\/).+\.(test|spec)\.(js|jsx|ts|tsx|cjs|mjs)$/.test(file))).toBe(true);
        expect(readFileSync(`${projectDir}/package.json`, 'utf-8')).toContain('vitest');
    }, 600000);

    // ─── SANDBOX ─────────────────────────────────────────────────────────

    it('Step 14 — Read outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step14', 'What files are in the parent directory?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseSignal(before);
        expect(hasResponseSignal(before)).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 15 — Write outside project', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step15',
            'Create a file at `../outside-test.txt` with the content "boundary test".'));

        const hadPerm = await Promise.race([
            waitForAnyPendingPermission(15000).then(() => true),
            waitForStepFinish(node, sessionId, before, FINISH_TIMEOUT).then(() => false),
        ]);

        if (hadPerm) {
            const pending = findFirstPendingPermission();
            if (pending) {
                await node.denyPermission(pending.sessionId, pending.permission.permissionId, { reason: 'Outside project' });
            }
            await waitForStepFinishApprovingAll(before);
        }

        const allSince = assistantMessagesSince(before);
        expect(allSince.some(m => hasPart(m, 'text') || hasPart(m, 'step-finish'))).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO ────────────────────────────────────────────────────────────

    it('Step 16 — Create todos', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step16',
            'Create a todo list for this project. Track: 1) add due dates to todos, 2) add drag-to-reorder, 3) add export to JSON. Use your todo tracking.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(getFullText(resp!)).toMatch(/due date|drag|export|json|todo|track/i);
    }, STEP_TIMEOUT);

    // ─── MODEL SWITCH ────────────────────────────────────────────────────

    it('Step 17 — Switch model and edit', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const appBefore = readFileSync(`${projectDir}/app.js`, 'utf-8');
        const indexBefore = readFileSync(`${projectDir}/index.html`, 'utf-8');
        await node.sendMessage(sessionId, makeUserMessage('step17', sessionId,
            'Add a "due date" field to the todo items. Add a date picker input next to the text input in the form. Store the date in localStorage with the item.',
            'opencode',
            { providerID: 'openai', modelID: 'gpt-5.3-codex-spark' },
        ));

        await waitForStepFinishApprovingAll(before);
        expect(
            hasFamilyTerminalToolOutcome(sessionId, familyBefore)
            || readFileSync(`${projectDir}/app.js`, 'utf-8') !== appBefore
            || readFileSync(`${projectDir}/index.html`, 'utf-8') !== indexBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── COMPACTION ──────────────────────────────────────────────────────

    it('Step 18 — Compact', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step18', 'Compact the context.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseSignal(before);
        expect(hasResponseSignal(before)).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 19 — Post-compaction sanity', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step19', 'What files have we changed so far?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(getFullText(resp!)).toMatch(
            /app\.js|styles\.css|index\.html|package\.json|app\.test\.js|vitest\.config|\.html/i,
        );
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
            agent: 'opencode',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step22', 'What was the last thing we were working on?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    // ─── TODO (continued) ────────────────────────────────────────────────

    it('Step 23 — Mark todo done', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step23',
            'Mark the "add due dates" todo as completed — we just did that.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(getFullText(resp!)).toMatch(/due date|completed|done|marked|todo/i);
    }, STEP_TIMEOUT);

    // ─── MULTI-PERMISSION ────────────────────────────────────────────────

    it('Step 25 — Multiple permissions in one turn', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step25',
            'Refactor the app: extract the filter logic into a new file called `filters.js`, move the dark mode toggle into a new file called `theme.js`, and update app.js to import from both.'));

        await waitForStepFinishApprovingAll(before);
        await waitForCondition(() => {
            if (!existsSync(`${projectDir}/filters.js`) || !existsSync(`${projectDir}/theme.js`)) {
                return false;
            }

            const appJs = readFileSync(`${projectDir}/app.js`, 'utf-8');
            const indexHtml = readFileSync(`${projectDir}/index.html`, 'utf-8');
            const references = `${appJs}\n${indexHtml}`;

            return references.includes('filters.js') && references.includes('theme.js');
        }, 30000);

        expect(existsSync(`${projectDir}/filters.js`)).toBe(true);
        expect(existsSync(`${projectDir}/theme.js`)).toBe(true);
        expect(`${readFileSync(`${projectDir}/app.js`, 'utf-8')}\n${readFileSync(`${projectDir}/index.html`, 'utf-8')}`).toContain('filters.js');
        expect(`${readFileSync(`${projectDir}/app.js`, 'utf-8')}\n${readFileSync(`${projectDir}/index.html`, 'utf-8')}`).toContain('theme.js');
    }, STEP_TIMEOUT);

    it('Step 26 — Supersede pending permissions', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step26',
            'Actually, undo all that. Put everything back in app.js. Also add a comment at the top: "// single-file architecture".'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseSignal(before);
        expect(hasResponseSignal(before)).toBe(true);
    }, STEP_TIMEOUT);

    // ─── SUBAGENT PERMISSIONS ────────────────────────────────────────────

    it('Step 27 — Subagent hits permission wall', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step27',
            'Use a subagent to add a "clear completed" button. The subagent should edit index.html and app.js. Don\'t auto-approve anything for it.'));

        // waitForStepFinishApprovingAll already approves across ALL sessions
        await waitForStepFinishApprovingAll(before);

        expect(hasResponseSignal(before)).toBe(true);
    }, STEP_TIMEOUT);

    // ─── STOP WITH PENDING STATE ─────────────────────────────────────────

    it('Step 28 — Stop while permission pending', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step28',
            'Add a new "priority" field to todos — high, medium, low. Use a colored dot next to each item.'));

        // Wait for a permission OR turn settled (OpenCode might auto-approve)
        await waitForPermissionOrSettled(before);

        await node.stopSession(sessionId);
        expect(session().status.type).toBe('completed');
    }, STEP_TIMEOUT);

    it('Step 29 — Resume after forced stop', async () => {
        sessionId = await spawnSessionViaDaemon({
            directory: projectDir,
            agent: 'opencode',
        }) as SessionID;
        await waitForCondition(() => node.state.sessions.has(sessionId as string), 30000);

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step29', 'What happened with the priority feature?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 30 — Retry after stop', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const appBefore = readFileSync(`${projectDir}/app.js`, 'utf-8');
        const indexBefore = readFileSync(`${projectDir}/index.html`, 'utf-8');
        await node.sendMessage(sessionId, msg('step30',
            'Try again — add the priority field. Approve everything this time.'));

        await waitForStepFinishApprovingAll(before);
        expect(
            hasFamilyTerminalToolOutcome(sessionId, familyBefore)
            || readFileSync(`${projectDir}/app.js`, 'utf-8') !== appBefore
            || readFileSync(`${projectDir}/index.html`, 'utf-8') !== indexBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── BACKGROUND TASKS ────────────────────────────────────────────────

    it('Step 31 — Launch background task', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        await node.sendMessage(sessionId, msg('step31',
            'Run a background task that sleeps for 30 seconds and then echoes "lol i am donezen". While it\'s running, tell me what time it is.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);

        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
        expect(assistantFamilyToolsSince(sessionId, familyBefore).length).toBeGreaterThan(0);
    }, STEP_TIMEOUT);

    it('Step 32 — Background completes', async () => {
        // Wait for the background task output to include "donezen"
        // OpenCode may not have a formal background task mechanism — just check
        // if any tool output contains the string
        try {
            await waitForCondition(() => {
                const msgs = getAssistantMessages(node, sessionId);
                for (const m of msgs) {
                    for (const t of getToolParts(m)) {
                        if (t.state.status === 'completed' &&
                            'output' in t.state &&
                            typeof t.state.output === 'string' &&
                            t.state.output.includes('donezen')) {
                            return true;
                        }
                    }
                }
                return false;
            }, 60000);
        } catch {
            // Background task may not have completed yet — proceed anyway
        }

        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step32',
            'Did that background task finish? What was the output?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        // OpenCode may or may not echo "donezen" — just check it completed
        expect(hasPart(resp!, 'text')).toBe(true);
    }, 240000);

    it('Step 33 — Foreground + background concurrent', async () => {
        const before = assistantCount();
        const familyBefore = captureFamilyAssistantSnapshot(sessionId);
        const appBefore = readFileSync(`${projectDir}/app.js`, 'utf-8');
        await node.sendMessage(sessionId, msg('step33',
            'Run another background task: sleep 20 && echo "background two". While that\'s running, add a comment to the top of app.js saying "// background task test".'));

        await waitForStepFinishApprovingAll(before);

        const tools = assistantFamilyToolsSince(sessionId, familyBefore);
        expect(tools.length).toBeGreaterThanOrEqual(1);
        expect(
            tools.some(t => t.state.status === 'completed')
            || readFileSync(`${projectDir}/app.js`, 'utf-8') !== appBefore,
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── WRAP UP ─────────────────────────────────────────────────────────

    it('Step 34 — Full summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step34',
            'Give me a git-style summary of everything we changed so far. List files modified, lines added/removed if you can tell.'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
        expect(getFullText(resp!).length).toBeGreaterThan(50);
    }, STEP_TIMEOUT);

    // ─── BACKGROUND SUBAGENTS (TaskCreate/TaskOutput) ────────────────────
    // OpenCode may not support formal TaskCreate/TaskOutput. Send the prompts
    // and check for any reasonable response — the agent may handle background
    // work differently or just process sequentially.

    it('Step 35 — Background subagent (TaskCreate)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step35',
            "Launch a background agent task: have it research what CSS frameworks would work well for this project. Don't wait for it — tell me about the current project structure while it works."));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 36 — Check background agent result (TaskOutput)', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step36',
            'Did that background research finish? What did it find?'));

        await waitForStepFinishApprovingAll(before);
        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
    }, STEP_TIMEOUT);

    it('Step 37 — Multiple background tasks', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step37',
            'Launch two background tasks in parallel: one to check if our HTML is valid, another to analyze our CSS for unused rules. While they run, add a comment to app.js saying "// multi-task test".'));

        await waitForStepFinishApprovingAll(before);

        const tools = assistantToolsSince(before);
        expect(
            tools.some(t => t.state.status === 'completed')
            || readFileSync(`${projectDir}/app.js`, 'utf-8').includes('// multi-task test'),
        ).toBe(true);
    }, STEP_TIMEOUT);

    // ─── WRAP UP (final) ─────────────────────────────────────────────────

    it('Step 38 — Final summary', async () => {
        const before = assistantCount();
        await node.sendMessage(sessionId, msg('step38',
            'Update your earlier summary with everything we did since then, including the background tasks. Give me the final git-style summary.'));

        await waitForStepFinishApprovingAll(before);

        // Drain: wait for all tools across all messages to reach terminal state
        try {
            await waitForCondition(() => {
                const msgs = getAssistantMessages(node, sessionId);
                for (const m of msgs) {
                    if (!hasPart(m, 'step-finish')) continue;
                    for (const t of getToolParts(m)) {
                        if (t.state.status !== 'completed' && t.state.status !== 'error') {
                            return false;
                        }
                    }
                }
                return true;
            }, 30000);
        } catch {
            console.log('[Step 38] Warning: some tools did not reach terminal state');
        }

        await waitForResponseText(before);
        const resp = getResponseMessage(before);
        expect(resp).toBeDefined();
        expect(hasPart(resp!, 'text')).toBe(true);
        expect(getFullText(resp!).length).toBeGreaterThan(50);
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
            // Intermediate messages (from late ACP events after turn end) may
            // only have step-start. Only check content + step-finish on
            // messages that HAVE a step-finish.
            if (hasPart(msg, 'step-finish')) {
                expect(msg.parts.filter(p => p.type !== 'step-start' && p.type !== 'step-finish').length).toBeGreaterThan(0);
            }
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
        // Only check tools on finalized messages (those with step-finish).
        // Intermediate messages from late ACP events may have running tools.
        for (const msg of getAssistantMessages(node, sessionId)) {
            if (!hasPart(msg, 'step-finish')) continue;
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
}, 2400000); // 40 min — full 38-step flow
