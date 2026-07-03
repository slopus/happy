import type { Metadata } from '@/api/types';
import { decodeBase64, decrypt } from '@/api/encryption';
import type { SessionEncryptionData, TrackedSession } from './types';

export interface ServerSessionSnapshot {
  metadata: Metadata;
  seq?: number;
  metadataVersion?: number;
  agentStateVersion?: number;
}

interface RawServerSession {
  id?: unknown;
  metadata?: unknown;
  seq?: unknown;
  metadataVersion?: unknown;
  agentStateVersion?: unknown;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function parseServerSessionSnapshot(
  sessions: unknown,
  sessionId: string,
  encryption: Pick<SessionEncryptionData, 'encryptionKey' | 'encryptionVariant'>,
): ServerSessionSnapshot | null {
  if (!Array.isArray(sessions)) return null;

  const matched = (sessions as RawServerSession[]).find((session) => session.id === sessionId);
  if (!matched || typeof matched.metadata !== 'string') return null;

  const metadata = decrypt(
    encryption.encryptionKey,
    encryption.encryptionVariant,
    decodeBase64(matched.metadata),
  ) as Metadata;

  return {
    metadata,
    seq: toNonNegativeInteger(matched.seq),
    metadataVersion: toNonNegativeInteger(matched.metadataVersion),
    agentStateVersion: toNonNegativeInteger(matched.agentStateVersion),
  };
}

export function applyServerSessionSnapshot(
  tracked: Pick<TrackedSession, 'happySessionMetadataFromLocalWebhook' | 'encryption'>,
  snapshot: ServerSessionSnapshot,
): Metadata {
  tracked.happySessionMetadataFromLocalWebhook = snapshot.metadata;

  if (tracked.encryption) {
    if (snapshot.seq !== undefined) {
      tracked.encryption.seq = Math.max(tracked.encryption.seq, snapshot.seq);
    }
    if (snapshot.metadataVersion !== undefined) {
      tracked.encryption.metadataVersion = Math.max(tracked.encryption.metadataVersion, snapshot.metadataVersion);
    }
    if (snapshot.agentStateVersion !== undefined) {
      tracked.encryption.agentStateVersion = Math.max(tracked.encryption.agentStateVersion, snapshot.agentStateVersion);
    }
  }

  return snapshot.metadata;
}
