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
 * but this key is like the draft's attachments: it is only meaningful while the
 * machine still remembers the in-flight request, and a key restored days later
 * would at best be ignored and at worst attach to something unrelated.
 */
import { randomUUID } from 'expo-crypto';

export type SpawnRequestSignatureInput = {
    machineId: string | null;
    agent: string;
    /** Directory as the user picked it, before any worktree resolution. */
    directory: string;
    worktree: string | null;
    modelKey: string | null;
    permissionMode: string | null;
    effort: string | null;
};

let pendingRequest: { signature: string; clientRequestId: string } | null = null;

/** Stable description of "the same spawn the user is asking for". */
export function buildSpawnRequestSignature(input: SpawnRequestSignatureInput): string {
    return JSON.stringify([
        input.machineId ?? '',
        input.agent,
        input.directory,
        input.worktree ?? '',
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
    if (pendingRequest?.signature === signature) {
        return pendingRequest.clientRequestId;
    }
    pendingRequest = { signature, clientRequestId: randomUUID() };
    return pendingRequest.clientRequestId;
}

/**
 * Called once a spawn produced a session, so the next spawn of an identical
 * request is treated as a new one rather than deduped into the finished session.
 */
export function completeSpawnRequest(): void {
    pendingRequest = null;
}
