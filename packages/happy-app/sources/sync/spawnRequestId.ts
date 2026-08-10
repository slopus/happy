/**
 * Idempotency key lifecycle for session spawning.
 *
 * Rig's `spawn-happy-session` RPC dedupes on `clientRequestId`: that key is the
 * only thing that makes a retry safe, because the second call returns the
 * session the first call created instead of creating another one. Minting a
 * fresh UUID on every send threw that guarantee away — once the `pending` retry
 * budget ran out (or an RPC timed out after Rig had already spawned), the user
 * doing the obvious thing and pressing Start again shipped a brand new key, so
 * Rig spawned a SECOND session in the same directory and the prompt only ever
 * reached the newest one.
 *
 * The key therefore lives here, keyed by a signature of what the user asked
 * for. It is reused for every retry of that same request and replaced only once
 * a spawn actually produced a session, or once the user changed the request.
 *
 * It is deliberately in-memory only. The new session draft persists to MMKV,
 * but this key is like the draft's attachments: it is only meaningful during a
 * short retry window. Restoring it days later could attach a new Start action to
 * an old session that Rig still associates with the same key.
 */
import { randomUUID } from 'expo-crypto';

export type SpawnRequestSignatureInput = {
    machineId: string | null;
    agent: string;
    /** Effective directory passed to the spawn RPC. */
    directory: string;
    worktree: string | null;
    /** Normalized name when `worktree` requests a freshly-created worktree. */
    newWorktreeName: string | null;
    modelKey: string | null;
    permissionMode: string | null;
    effort: string | null;
};

/**
 * A retry is only considered the same user action for a bounded time. Reusing
 * a key from a session started hours ago would reopen that old session instead
 * of honoring a new press of Start.
 */
export const PENDING_SPAWN_REQUEST_TTL_MS = 5 * 60 * 1000;

let pendingRequest: {
    signature: string;
    clientRequestId: string;
    mintedAt: number;
} | null = null;

/** Stable description of "the same spawn the user is asking for". */
export function buildSpawnRequestSignature(input: SpawnRequestSignatureInput): string {
    return JSON.stringify([
        input.machineId ?? '',
        input.agent,
        input.directory,
        input.worktree ?? '',
        input.newWorktreeName ?? '',
        input.modelKey ?? '',
        input.permissionMode ?? '',
        input.effort ?? '',
    ]);
}

/**
 * The idempotency key for this request. Retrying an unchanged request reuses
 * the previous key; any change to the request mints a new one.
 */
export function resolveSpawnRequestId(signature: string): string {
    const now = Date.now();
    if (
        pendingRequest?.signature === signature
        && now >= pendingRequest.mintedAt
        && now - pendingRequest.mintedAt < PENDING_SPAWN_REQUEST_TTL_MS
    ) {
        return pendingRequest.clientRequestId;
    }
    pendingRequest = { signature, clientRequestId: randomUUID(), mintedAt: now };
    return pendingRequest.clientRequestId;
}

/**
 * Called once a spawn produced a session, so the next spawn of an identical
 * request is treated as a new one rather than deduped into the finished session.
 */
export function completeSpawnRequest(): void {
    pendingRequest = null;
}
