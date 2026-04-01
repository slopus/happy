/**
 * Shared helpers for Level 2 E2E agent flow tests.
 *
 * Used by claude.integration.test.ts, codex.integration.test.ts,
 * and opencode.integration.test.ts.
 */

import { SyncNode, type SyncNodeToken } from '../sync-node';
import { type KeyMaterial } from '../encryption';
import type { ResolveSessionKeyMaterial } from '../sync-node';
import type { MessageWithParts, SessionID, MessageID, PartID, Part } from '../v3-compat';
import { createId } from '@paralleldrive/cuid2';
import { getServerUrl, getAuthToken, getEncryptionSecret } from './setup';
import type { MessageMeta } from '../messageMeta';

// ─── Token / Key helpers ─────────────────────────────────────────────────────

export function makeAccountToken(): SyncNodeToken {
    return {
        raw: getAuthToken(),
        claims: {
            scope: { type: 'account' as const, userId: 'test-user' },
            permissions: ['read', 'write', 'admin'],
        },
    };
}

/**
 * Key material using the same encryption secret as the daemon/CLI.
 * In legacy mode, the CLI encrypts sessions with the secret from access.key.
 * The test's SyncNode needs the same key to decrypt messages.
 */
export function makeKeyMaterial(): KeyMaterial {
    return { key: getEncryptionSecret(), variant: 'legacy' };
}

/**
 * Session key resolver for the test's SyncNode.
 *
 * Handles two cases:
 * 1. Sessions created by the CLI (legacy mode) — `dataEncryptionKey` is null,
 *    so we fall back to defaultKeyMaterial (which is the shared secret).
 * 2. Sessions with a stored data key (dataKey mode) — decode the base64 key.
 */
export const resolveSessionKeyMaterial: ResolveSessionKeyMaterial = async ({
    encryptedDataKey,
    defaultKeyMaterial,
}) => {
    if (!encryptedDataKey) {
        // Legacy mode: no per-session key, use the shared secret
        return defaultKeyMaterial;
    }

    // Try to decode as a raw 32-byte key (simple dataKey mode, no asymmetric encryption)
    const keyBytes = Buffer.from(encryptedDataKey, 'base64');
    if (keyBytes.length === 32) {
        return { key: new Uint8Array(keyBytes), variant: 'dataKey' as const };
    }

    // Otherwise fall back to default
    return defaultKeyMaterial;
};

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
 * Wait for a final step-finish part on the latest assistant message.
 *
 * A "final" step-finish is one where `reason` is NOT `tool-calls` — meaning
 * the agent completed its work rather than just pausing for tool execution.
 * Each LLM turn produces its own step-start/step-finish pair; we want the
 * turn where the agent is truly done (reason = "end_turn" or similar).
 */
export async function waitForStepFinish(
    node: SyncNode,
    sessionId: SessionID,
    afterAssistantCount: number,
    timeoutMs = 120000,
): Promise<void> {
    let lastLogAt = 0;
    await waitForCondition(() => {
        const msgs = getAssistantMessages(node, sessionId);
        if (msgs.length <= afterAssistantCount) return false;

        // Debug: log assistant message structure every 10s
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
                console.log(`[waitForStepFinish] msg[${i}] (${m.parts.length} parts): ${partTypes.join(', ')}`);
            }
        }

        // Check ALL new messages (not just the last one) for a final step-finish
        for (let i = afterAssistantCount; i < msgs.length; i++) {
            if (hasFinalStepFinish(msgs[i])) return true;
        }
        return false;
    }, timeoutMs);
}

/**
 * Check if a message has a "final" step-finish (reason !== 'tool-calls').
 */
function hasFinalStepFinish(msg: MessageWithParts): boolean {
    return msg.parts.some(
        p => p.type === 'step-finish' && (p as any).reason !== 'tool-calls',
    );
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
    meta?: MessageMeta,
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
            ...(meta ? { meta } : {}),
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
