/**
 * Serializes the latest server-owned session metadata for a single daemon
 * resume spawn. The payload is local-only and covered by the reconnect lineage
 * environment scrub, so it cannot leak into unrelated child sessions.
 */

import type { Metadata } from '@/api/types';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { ServerSessionSnapshot } from './serverSessionSnapshot';
import type { SessionEncryptionData } from './types';

export const MAX_RECONNECT_SNAPSHOT_BYTES = 128 * 1024;

export interface ReconnectSessionSnapshot {
    metadata: Metadata;
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
}

export interface ReconnectSessionEnvironment {
    HAPPY_RECONNECT_SESSION_ID: string;
    HAPPY_RECONNECT_ENCRYPTION_KEY: string;
    HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy' | 'dataKey';
    HAPPY_RECONNECT_SNAPSHOT: string;
}

export interface ReconnectSessionClientSnapshot extends ReconnectSessionSnapshot {
    id: string;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function assertReconnectSessionSnapshot(value: unknown): asserts value is ReconnectSessionSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid reconnect session snapshot: expected an object');
    }
    const snapshot = value as Record<string, unknown>;
    const metadata = snapshot.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('Invalid reconnect session snapshot: metadata is missing');
    }
    const path = (metadata as Record<string, unknown>).path;
    if (typeof path !== 'string' || path.length === 0) {
        throw new Error('Invalid reconnect session snapshot: metadata path is missing');
    }
    if (
        !isNonNegativeInteger(snapshot.seq)
        || !isNonNegativeInteger(snapshot.metadataVersion)
        || !isNonNegativeInteger(snapshot.agentStateVersion)
    ) {
        throw new Error('Invalid reconnect session snapshot: versions must be non-negative integers');
    }
}

export function encodeReconnectSessionSnapshot(snapshot: ReconnectSessionSnapshot): string {
    assertReconnectSessionSnapshot(snapshot);
    const json = JSON.stringify(snapshot);
    if (Buffer.byteLength(json, 'utf8') > MAX_RECONNECT_SNAPSHOT_BYTES) {
        throw new Error(`Reconnect session snapshot is too large (max ${MAX_RECONNECT_SNAPSHOT_BYTES} bytes)`);
    }
    return Buffer.from(json, 'utf8').toString('base64');
}

export function decodeReconnectSessionSnapshot(encoded: string): ReconnectSessionSnapshot {
    try {
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.byteLength > MAX_RECONNECT_SNAPSHOT_BYTES) {
            throw new Error(`snapshot is too large (max ${MAX_RECONNECT_SNAPSHOT_BYTES} bytes)`);
        }
        const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
        assertReconnectSessionSnapshot(snapshot);
        return snapshot;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid reconnect session snapshot:')) {
            throw error;
        }
        throw new Error(`Invalid reconnect session snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Skip baseline for a resumed child: messages with seq ≤ baseline are never
 * delivered. Messages that arrived while the session had no process exist on
 * the server but were never processed, so the baseline must be the last seq
 * the previous child actually delivered to its agent loop — not the server
 * head, which silently swallows that dead-period input.
 *
 * Precedence: the live runtime report (`reportedSeq`) first, then the value
 * persisted for this session (`persistedSeq`), which is all that survives a
 * daemon restart.
 *
 * A known seq wins outright, with no floor from the tracked webhook seq: that
 * value is not an "already processed" marker, and `applyServerSessionSnapshot`
 * rewrites it to the server head on every resume attempt, so flooring against it
 * would re-swallow the messages this baseline exists to deliver.
 *
 * The server head remains the fallback for sessions that never reported (older
 * CLI, lost record), where replaying already-processed turns is the greater risk.
 */
export function resolveResumeBaselineSeq(input: {
    reportedSeq?: number;
    persistedSeq?: number;
    webhookSeq: number;
    serverSeq?: number;
}): number {
    const knownSeq = input.reportedSeq ?? input.persistedSeq;
    if (knownSeq !== undefined) {
        return knownSeq;
    }
    return Math.max(input.webhookSeq, input.serverSeq ?? 0);
}

/**
 * Same-session reconnects must not guess at the processed-message boundary.
 * Falling back to the server head can acknowledge unseen user input that
 * arrived while no child process was attached. Callers without a durable
 * cursor must continue the native provider conversation in a new Happy session.
 */
export function hasReliableResumeBaseline(input: {
    reportedSeq?: number;
    persistedSeq?: number;
}): boolean {
    return input.reportedSeq !== undefined || input.persistedSeq !== undefined;
}

export function buildReconnectSessionEnvironment(input: {
    sessionId: string;
    encryption: SessionEncryptionData;
    serverSnapshot: ServerSessionSnapshot | null;
    /** Overrides the default head-based skip baseline (see resolveResumeBaselineSeq). */
    baselineSeq?: number;
}): ReconnectSessionEnvironment {
    if (!input.serverSnapshot) {
        throw new Error('Cannot safely resume without the latest server session snapshot');
    }

    return {
        HAPPY_RECONNECT_SESSION_ID: input.sessionId,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(input.encryption.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: input.encryption.encryptionVariant,
        HAPPY_RECONNECT_SNAPSHOT: encodeReconnectSessionSnapshot({
            metadata: input.serverSnapshot.metadata,
            seq: input.baselineSeq ?? Math.max(input.encryption.seq, input.serverSnapshot.seq ?? 0),
            metadataVersion: Math.max(
                input.encryption.metadataVersion,
                input.serverSnapshot.metadataVersion ?? 0,
            ),
            agentStateVersion: Math.max(
                input.encryption.agentStateVersion,
                input.serverSnapshot.agentStateVersion ?? 0,
            ),
        }),
    };
}

export function readReconnectSessionEnvironment(
    env: NodeJS.ProcessEnv,
): ReconnectSessionClientSnapshot | null {
    const sessionId = env.HAPPY_RECONNECT_SESSION_ID;
    const encryptionKey = env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const encryptionVariant = env.HAPPY_RECONNECT_ENCRYPTION_VARIANT;
    const encodedSnapshot = env.HAPPY_RECONNECT_SNAPSHOT;
    const hasReconnectValue = Boolean(sessionId || encryptionKey || encryptionVariant || encodedSnapshot);

    if (!hasReconnectValue) return null;
    if (!sessionId || !encryptionKey || !encodedSnapshot || (encryptionVariant !== 'legacy' && encryptionVariant !== 'dataKey')) {
        throw new Error('Incomplete reconnect environment: refusing to rebuild stale session metadata');
    }

    const decodedKey = decodeBase64(encryptionKey);
    if (decodedKey.byteLength !== 32) {
        throw new Error('Incomplete reconnect environment: encryption key must be 32 bytes');
    }
    const snapshot = decodeReconnectSessionSnapshot(encodedSnapshot);
    return {
        id: sessionId,
        encryptionKey: decodedKey,
        encryptionVariant,
        ...snapshot,
    };
}

/**
 * Reads the reconnect environment and removes the session data key from it.
 *
 * Agent runners call this on `process.env` before they start the agent: the key
 * is the session's data key, and every process the agent or its tools start
 * would otherwise inherit it. The key is removed even when the rest of the
 * environment is refused. The other HAPPY_RECONNECT_* values stay; later code
 * still reads them to recognise a reconnect.
 */
export function consumeReconnectSessionEnvironment(
    env: NodeJS.ProcessEnv,
): ReconnectSessionClientSnapshot | null {
    try {
        return readReconnectSessionEnvironment(env);
    } finally {
        delete env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    }
}
