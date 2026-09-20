/**
 * Happy Agent composer synchronization (phone side).
 *
 * The daemon owns the durable composer; the phone edits it through the
 * session's encrypted metadata as one whole `draft` (text plus every picker)
 * stamped with `draftUpdatedAt`. Every edit updates the local mirror on the
 * session right away with a stamp taken at the edit, then the write is
 * serialized per session: typing is debounced, picker changes and empty-text
 * edits go immediately. On a version conflict the draft is re-applied onto
 * the newest metadata, unless the remote draft is stamped equally or newer — then it is
 * adopted and the stale local text is not resent. `lastMode` is never written.
 * The pending draft is also persisted locally so an offline edit survives
 * restart; on cold start the newer stamp wins, and a winning local draft is
 * written once the session connects.
 */
import { apiSocket } from './apiSocket';
import { sync } from './sync';
import { storage } from './storage';
import { MetadataSchema, type RigComposerDraft, type Session } from './storageTypes';
import {
    getRigComposerMode,
    getRigModels,
    getRigReasoningSelection,
    isRigMetadataV1,
    qualifyRigModelKey,
} from './rig';

export const RIG_DRAFT_DEBOUNCE_MS = 250;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

type Writer = { timer: ReturnType<typeof setTimeout> | null; running: boolean; dirty: boolean; retryDelayMs: number };
const writers = new Map<string, Writer>();

function writerFor(sessionId: string): Writer {
    let writer = writers.get(sessionId);
    if (!writer) {
        writer = { timer: null, running: false, dirty: false, retryDelayMs: RETRY_DELAY_MS };
        writers.set(sessionId, writer);
    }
    return writer;
}

function rigSession(sessionId: string): Session | null {
    const session = storage.getState().sessions[sessionId];
    return session && isRigMetadataV1(session.metadata) ? session : null;
}

/** Monotonic per session: later than now and later than anything already seen. */
function stampFor(session: Session): number {
    const seen = Math.max(session.draftUpdatedAt ?? 0, session.metadata?.draftUpdatedAt ?? 0);
    return Math.max(Date.now(), seen + 1);
}

/** The full draft the daemon expects; fields the composer left unset fall back to the session's current selection. */
export function composeRigDraft(session: Pick<Session, 'metadata' | 'draft' | 'modelMode' | 'effortLevel' | 'permissionMode' | 'serviceTier'>): RigComposerDraft {
    const metadata = session.metadata;
    const mode = getRigComposerMode(metadata);
    const modelKey = session.modelMode ?? (mode ? qualifyRigModelKey(mode.providerId, mode.modelId) : null);
    const model = getRigModels(metadata).find((candidate) => candidate.key === modelKey);
    const separator = modelKey?.indexOf(':') ?? -1;
    const providerId = model?.providerId ?? (separator > 0 ? modelKey!.slice(0, separator) : metadata?.currentModelProviderId ?? '');
    const modelId = model?.id ?? (separator > 0 ? modelKey!.slice(separator + 1) : metadata?.currentModelCode ?? '');
    const effort = (session.effortLevel && (!model || model.thinkingLevels.includes(session.effortLevel)) ? session.effortLevel : null)
        ?? getRigReasoningSelection(metadata, modelKey)
        ?? model?.defaultThinkingLevel
        ?? mode?.effort
        ?? metadata?.currentThoughtLevelCode
        ?? '';
    const requestedTier = session.serviceTier !== undefined
        ? session.serviceTier
        : mode?.serviceTier ?? metadata?.session?.serviceTier ?? null;
    const serviceTier = requestedTier === null || !model
        ? requestedTier
        : model.serviceTiers.length === 0
            ? null
            : model.serviceTiers.includes(requestedTier)
                ? requestedTier
                : null;
    return {
        text: session.draft ?? '',
        providerId,
        modelId,
        effort,
        serviceTier,
        permissionMode: session.permissionMode
            ?? mode?.permissionMode
            ?? metadata?.currentOperatingModeCode
            ?? metadata?.permissionMode
            ?? metadata?.session?.permissionMode
            ?? '',
    };
}

/** Composer text changed. Stamped now; the write waits for a pause in typing unless the text is empty. */
export function rigComposerSetText(sessionId: string, text: string): void {
    const session = rigSession(sessionId);
    if (!session || (session.draft ?? '') === text) return;
    storage.getState().updateSessionComposer(sessionId, { draft: text, draftUpdatedAt: stampFor(session) });
    schedule(sessionId, text.length === 0 ? 0 : RIG_DRAFT_DEBOUNCE_MS);
}

/** A picker changed. Written immediately, together with whatever text is in the composer. */
export function rigComposerSetMode(
    sessionId: string,
    patch: { permissionMode?: string | null; modelMode?: string | null; effortLevel?: string | null },
): void {
    const session = rigSession(sessionId);
    if (!session) return;
    const next = { ...session, ...patch, draft: session.draft ?? '' };
    // Keep the mirror concrete so the composer and the written draft agree.
    if (patch.modelMode !== undefined || patch.effortLevel === null) {
        const draft = composeRigDraft(next);
        next.effortLevel = draft.effort || null;
        next.serviceTier = draft.serviceTier;
    }
    storage.getState().updateSessionComposer(sessionId, {
        draft: next.draft,
        draftUpdatedAt: stampFor(session),
        ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        ...(patch.modelMode !== undefined ? { modelMode: patch.modelMode } : {}),
        ...(next.effortLevel !== session.effortLevel ? { effortLevel: next.effortLevel } : {}),
        ...(next.serviceTier !== session.serviceTier ? { serviceTier: next.serviceTier } : {}),
    });
    schedule(sessionId, 0);
}

/**
 * A send or deliberate discard: the draft becomes null under a new stamp while
 * the pickers keep the mode that was just used, until `lastMode` confirms it.
 * Cancels any pending typing write first. Nothing happens when there is no
 * draft to clear, so a send that already cleared is not written twice.
 */
export function rigComposerClear(sessionId: string): void {
    const session = rigSession(sessionId);
    if (!session || session.draft === null || session.draft === undefined) return;
    storage.getState().updateSessionComposer(sessionId, { draft: null, draftUpdatedAt: stampFor(session) });
    schedule(sessionId, 0);
}

function schedule(sessionId: string, delayMs: number): void {
    const writer = writerFor(sessionId);
    if (writer.timer) clearTimeout(writer.timer);
    writer.timer = null;
    if (delayMs > 0) {
        writer.timer = setTimeout(() => { writer.timer = null; flush(sessionId); }, delayMs);
    } else {
        flush(sessionId);
    }
}

/** Write now: used after a restart restore or when the session reconnects. */
export function rigComposerFlushPending(sessionId: string): void {
    const writer = writerFor(sessionId);
    if (writer.timer) {
        clearTimeout(writer.timer);
        writer.timer = null;
    }
    flush(sessionId);
}

/** Push every local draft that is stamped newer than the last metadata the phone has seen. */
export function rigComposerFlushAheadSessions(): void {
    for (const [sessionId, session] of Object.entries(storage.getState().sessions)) {
        if (!isRigMetadataV1(session.metadata)) continue;
        const localStamp = session.draftUpdatedAt ?? null;
        const remoteStamp = session.metadata?.draftUpdatedAt ?? null;
        if (localStamp !== null && (remoteStamp === null || localStamp > remoteStamp)) {
            rigComposerFlushPending(sessionId);
        }
    }
}

/** One write in flight per session; an edit during a write queues exactly one more. */
function flush(sessionId: string): void {
    const writer = writerFor(sessionId);
    if (writer.running) {
        writer.dirty = true;
        return;
    }
    writer.running = true;
    writer.dirty = false;
    writeDraft(sessionId)
        .then(() => { writer.retryDelayMs = RETRY_DELAY_MS; })
        .catch((error) => {
            console.error(`Failed to sync composer draft for session ${sessionId}`, error);
            // A newer edit already scheduled its own write. Otherwise retry while
            // connected; reconnect restores locally-ahead drafts when offline.
            if (writer.dirty || writer.timer || storage.getState().socketStatus !== 'connected') return;
            writer.timer = setTimeout(() => {
                writer.timer = null;
                const session = rigSession(sessionId);
                if (storage.getState().socketStatus === 'connected' && session
                    && (session.draftUpdatedAt ?? -1) > (session.metadata?.draftUpdatedAt ?? -1)) {
                    flush(sessionId);
                } else {
                    writers.delete(sessionId);
                }
            }, writer.retryDelayMs);
            writer.retryDelayMs = Math.min(writer.retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        })
        .finally(() => {
            writer.running = false;
            if (writer.dirty) flush(sessionId);
            else if (!writer.timer) writers.delete(sessionId);
        });
}

async function writeDraft(sessionId: string, maxRetries: number = 3): Promise<void> {
    const encryption = sync.encryption.getSessionEncryption(sessionId);
    const first = rigSession(sessionId);
    if (!encryption || !first?.metadata) return;
    let version = first.metadataVersion;
    let base: Record<string, unknown> = first.metadata;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Always write the newest local state, not the one that scheduled this write.
        const session = rigSession(sessionId);
        if (!session) return;
        const draft = session.draft === null || session.draft === undefined ? null : composeRigDraft(session);
        const encrypted = await encryption.encryptRaw({ ...base, draft, draftUpdatedAt: session.draftUpdatedAt ?? null });
        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
        }>('update-metadata', { sid: sessionId, metadata: encrypted, expectedVersion: version });

        if (result.result === 'success') return;
        if (result.result !== 'version-mismatch') throw new Error('Failed to update session metadata');

        version = result.version!;
        const latest = await encryption.decryptRaw(result.metadata!);
        if (!latest) throw new Error('Failed to decrypt latest session metadata');
        base = latest;
        // Merge onto the newest metadata. applySessions adopts the remote draft
        // when it is stamped equally or newer; then there is nothing left to send.
        const remoteStamp = typeof latest.draftUpdatedAt === 'number' ? latest.draftUpdatedAt : null;
        const parsed = MetadataSchema.safeParse(latest);
        if (parsed.success) {
            storage.getState().applySessions([{ ...session, metadata: parsed.data, metadataVersion: version }]);
        }
        if (remoteStamp !== null && remoteStamp >= (rigSession(sessionId)?.draftUpdatedAt ?? -1)) return;
    }
    throw new Error(`Failed to update session metadata after ${maxRetries} retries due to version conflicts`);
}
