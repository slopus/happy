import { readAgentRoleResult } from '@/components/tools/views/agentRoleResult';
import { resolveConversationRootSessionId } from './conversationSession';
import { findRoleConfigurationForSession, readRoleConfiguration, recordRoleConfigurationSavedResult, roleConfigurationCurrent } from './roleConfigurationHandoff';
import { getFirstSubmissionScope } from './firstSubmissionScope';
import { createReducer, reducer } from './reducer/reducer';
import type { Session } from './storageTypes';
import type { Message } from './typesMessage';
import type { NormalizedMessage } from './typesRaw';

type Binding = { owner: NonNullable<ReturnType<typeof getFirstSubmissionScope>>; handoffId: string; revision: number; rootSessionId: string; machineId: string };
type PendingCall = Binding & { start?: NormalizedMessage; end?: NormalizedMessage };
const pendingCalls = new Map<string, PendingCall>();
const MAX_PENDING_CALLS = 32;
const MAX_CALL_LENGTH = 128 * 1024;
let pendingOwner: ReturnType<typeof getFirstSubmissionScope>;
function objectInput(value: unknown): Record<string, unknown> | null {
    try {
        const parsed = typeof value === 'string' && value.length <= MAX_CALL_LENGTH ? JSON.parse(value) : value;
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
}

/** Observe only role-tool call pairs for a locally bound handoff. Realtime can
 * arrive while an old history window or a sequence gap prevents UI projection;
 * this bounded reducer does not fetch, project, or retain ordinary messages. */
export function observeRoleConfigurationRealtimeMessage(sessionId: string, sessions: Readonly<Record<string, Session>>, message: NormalizedMessage) {
    const owner = getFirstSubmissionScope();
    if (owner !== pendingOwner) { pendingCalls.clear(); pendingOwner = owner; }
    if (!owner || message.role !== 'agent') return 0;
    let accepted = 0;
    for (const content of message.content) {
        if (content.type !== 'tool-call' && content.type !== 'tool-result') continue;
        const key = JSON.stringify([sessionId, content.parentUUID, content.type === 'tool-call' ? content.id : content.tool_use_id]);
        if (content.type === 'tool-call') {
            if (!['McpTool', 'agent_roles', 'mcp__happy__agent_roles'].includes(content.name)) continue;
            const wrapped = objectInput(content.input);
            if (content.name === 'McpTool' && (wrapped?.server !== 'happy' || wrapped.tool !== 'agent_roles')) continue;
            const input = content.name === 'McpTool' ? objectInput(wrapped?.arguments) : wrapped;
            if (input?.action !== 'create' && input?.action !== 'update') continue;
            const binding = currentBinding(sessionId, sessions, owner, message.createdAt);
            if (!binding) continue;
            const handoff = readRoleConfiguration(binding.handoffId)!;
            const requestedRoleId = input.action === 'update' ? input.roleId : objectInput(input.role)?.id;
            if (requestedRoleId !== handoff.roleId) continue;
            const start = boundedEvent(message, content);
            if (!start) { pendingCalls.delete(key); continue; }
            const pending = pendingCalls.get(key);
            const next: PendingCall = { ...binding, ...(pending && sameBinding(pending, binding) ? pending : {}), start };
            accepted += pairOrRetain(key, next, sessionId, sessions);
        } else {
            const pending = pendingCalls.get(key);
            const binding = currentBinding(sessionId, sessions, owner, message.createdAt);
            if (!binding) { pendingCalls.delete(key); continue; }
            const end = boundedEvent(message, content);
            if (!end) { pendingCalls.delete(key); continue; }
            // Decryption may finish out of order. Retain an orphan only for
            // this exact local handoff; its real tool name/input arrive later.
            const next: PendingCall = { ...binding, ...(pending && sameBinding(pending, binding) ? pending : {}), end };
            accepted += pairOrRetain(key, next, sessionId, sessions);
        }
    }
    return accepted;
}

function currentBinding(sessionId: string, sessions: Readonly<Record<string, Session>>, owner: Binding['owner'], createdAt: number): Binding | null {
    const machineId = sessions[sessionId]?.metadata?.machineId;
    const rootSessionId = resolveConversationRootSessionId(sessions, sessionId);
    if (!machineId || !rootSessionId) return null;
    const handoff = findRoleConfigurationForSession(machineId, rootSessionId);
    if (!handoff || !roleConfigurationCurrent(handoff, owner) || createdAt < (handoff.requestedAt ?? handoff.createdAt)) return null;
    return { owner, handoffId: handoff.id, revision: handoff.revision, rootSessionId, machineId };
}
function sameBinding(left: Binding, right: Binding) {
    return left.owner === right.owner && left.handoffId === right.handoffId && left.revision === right.revision
        && left.rootSessionId === right.rootSessionId && left.machineId === right.machineId;
}
function boundedEvent(message: NormalizedMessage, content: Extract<NormalizedMessage, { role: 'agent' }>['content'][number]): NormalizedMessage | null {
    try { if (JSON.stringify(content).length > MAX_CALL_LENGTH) return null; } catch { return null; }
    return { id: message.id, localId: message.localId, createdAt: message.createdAt, isSidechain: message.isSidechain, role: 'agent', content: [content] };
}
function pairOrRetain(key: string, pending: PendingCall, sessionId: string, sessions: Readonly<Record<string, Session>>) {
    pendingCalls.delete(key);
    if (pending.start && pending.end) {
        const output = reducer(createReducer(), [pending.start, pending.end], sessions[sessionId].agentState);
        return observeRoleConfigurationSavedMessages(sessionId, sessions, output.messages);
    }
    pendingCalls.set(key, pending);
    if (pendingCalls.size > MAX_PENDING_CALLS) pendingCalls.delete(pendingCalls.keys().next().value!);
    return 0;
}

/** Consume authoritative saved-role receipts when protocol messages are applied,
 * even when the user has already left the AI conversation. Rendering a result
 * card is optional; role-directory changes and assistant prose are never ACKs. */
export function observeRoleConfigurationSavedMessages(sessionId: string, sessions: Readonly<Record<string, Session>>, messages: readonly Message[]) {
    const receipts = messages.flatMap(message => {
        if (message.kind !== 'tool-call') return [];
        const role = readAgentRoleResult(message.tool);
        return role ? [{ role, toolCreatedAt: message.tool.createdAt }] : [];
    });
    if (!receipts.length) return 0;
    const machineId = sessions[sessionId]?.metadata?.machineId;
    const rootSessionId = resolveConversationRootSessionId(sessions, sessionId);
    if (!machineId || !rootSessionId) return 0;
    let accepted = 0;
    for (const receipt of receipts) {
        if (recordRoleConfigurationSavedResult({ machineId, sessionId: rootSessionId, ...receipt })) accepted++;
    }
    return accepted;
}
