/**
 * Shared helpers for Level 2 E2E agent flow tests.
 *
 * Used by claude.integration.test.ts, codex.integration.test.ts,
 * and opencode.integration.test.ts.
 */

import { SyncNode, type SyncNodeToken } from '../sync-node';
import { type KeyMaterial, getRandomBytes } from '../encryption';
import type { MessageWithParts, SessionID, MessageID, PartID, Part } from '../protocol';
import { createId } from '@paralleldrive/cuid2';

// ─── Config ──────────────────────────────────────────────────────────────────

export const SERVER_URL = process.env.HAPPY_TEST_SERVER_URL ?? 'http://localhost:3005';
export const AUTH_TOKEN = process.env.HAPPY_TEST_TOKEN ?? '';

// ─── Token / Key helpers ─────────────────────────────────────────────────────

export function makeAccountToken(token = AUTH_TOKEN): SyncNodeToken {
    return {
        raw: token,
        claims: {
            scope: { type: 'account' as const, userId: 'test-user' },
            permissions: ['read', 'write', 'admin'],
        },
    };
}

export function makeKeyMaterial(): KeyMaterial {
    return { key: getRandomBytes(32), variant: 'dataKey' };
}

// ─── Wait helpers ────────────────────────────────────────────────────────────

export function waitForCondition(
    check: () => boolean,
    timeoutMs = 60000,
    intervalMs = 500,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const timer = setInterval(() => {
            if (check()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error('Timed out waiting for condition'));
            }
        }, intervalMs);
    });
}

/**
 * Wait for a step-finish part on the latest assistant message that is newer
 * than `afterMessageCount` assistant messages.
 */
export async function waitForStepFinish(
    node: SyncNode,
    sessionId: SessionID,
    afterAssistantCount: number,
    timeoutMs = 120000,
): Promise<void> {
    await waitForCondition(() => {
        const msgs = getAssistantMessages(node, sessionId);
        if (msgs.length <= afterAssistantCount) return false;
        const last = msgs[msgs.length - 1];
        return hasPart(last, 'step-finish');
    }, timeoutMs);
}

/**
 * Wait for at least one unresolved permission in the session.
 */
export async function waitForPendingPermission(
    node: SyncNode,
    sessionId: SessionID,
    timeoutMs = 120000,
): Promise<void> {
    await waitForCondition(() => {
        const session = node.state.sessions.get(sessionId as string);
        return session?.permissions.some(p => !p.resolved) ?? false;
    }, timeoutMs);
}

/**
 * Wait for at least one unresolved question in the session.
 */
export async function waitForPendingQuestion(
    node: SyncNode,
    sessionId: SessionID,
    timeoutMs = 120000,
): Promise<void> {
    await waitForCondition(() => {
        const session = node.state.sessions.get(sessionId as string);
        return session?.questions.some(q => !q.resolved) ?? false;
    }, timeoutMs);
}

// ─── Message query helpers ───────────────────────────────────────────────────

export function getMessages(node: SyncNode, sessionId: SessionID): MessageWithParts[] {
    return node.state.sessions.get(sessionId as string)?.messages ?? [];
}

export function getAssistantMessages(node: SyncNode, sessionId: SessionID): MessageWithParts[] {
    return getMessages(node, sessionId).filter(m => m.info.role === 'assistant');
}

export function getUserMessages(node: SyncNode, sessionId: SessionID): MessageWithParts[] {
    return getMessages(node, sessionId).filter(m => m.info.role === 'user');
}

export function getLastAssistantMessage(node: SyncNode, sessionId: SessionID): MessageWithParts | undefined {
    const msgs = getAssistantMessages(node, sessionId);
    return msgs[msgs.length - 1];
}

// ─── Part query helpers ──────────────────────────────────────────────────────

export function hasPart(msg: MessageWithParts, type: Part['type']): boolean {
    return msg.parts.some(p => p.type === type);
}

export function getToolParts(msg: MessageWithParts): Array<Part & { type: 'tool' }> {
    return msg.parts.filter((p): p is Part & { type: 'tool' } => p.type === 'tool');
}

export function getTextParts(msg: MessageWithParts): Array<Part & { type: 'text' }> {
    return msg.parts.filter((p): p is Part & { type: 'text' } => p.type === 'text');
}

export function getSubtaskParts(msg: MessageWithParts): Array<Part & { type: 'subtask' }> {
    return msg.parts.filter((p): p is Part & { type: 'subtask' } => p.type === 'subtask');
}

export function getCompactionParts(msg: MessageWithParts): Array<Part & { type: 'compaction' }> {
    return msg.parts.filter((p): p is Part & { type: 'compaction' } => p.type === 'compaction');
}

export function getFullText(msg: MessageWithParts): string {
    return getTextParts(msg).map(t => t.text).join(' ').toLowerCase();
}

// ─── Message builder ─────────────────────────────────────────────────────────

export function makeUserMessage(
    id: string,
    sessionId: SessionID,
    text: string,
    agent = 'claude',
    model = { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
): MessageWithParts {
    const msgId = `msg_${createId()}` as MessageID;
    return {
        info: {
            id: msgId,
            sessionID: sessionId,
            role: 'user' as const,
            time: { created: Date.now() },
            agent,
            model,
        },
        parts: [{
            id: `prt_${createId()}` as PartID,
            sessionID: sessionId,
            messageID: msgId,
            type: 'text' as const,
            text,
        }],
    };
}
