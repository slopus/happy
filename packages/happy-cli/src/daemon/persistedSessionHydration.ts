/**
 * Restoring a TrackedSession's resume-critical fields from the on-disk store.
 *
 * The daemon builds TrackedSessions from three sources: the session-started
 * webhook (full data), the previous daemon's state file, and orphan runtime
 * reports. Only the webhook carries `encryption`, so the other two used to
 * produce sessions that looked tracked but could never be preserved for resume
 * — `preserveSessionForResume` bails without it. The reaper then killed such a
 * session without ever writing its `lastProcessedSeq` to disk, and every later
 * resume refused with SESSION_CURSOR_MISSING (2026-08-15 incident: a message
 * sent from the app was accepted by the server and answered by nobody).
 *
 * `sessions.json` already holds everything those two paths lack, so this is a
 * lookup, not a reconstruction.
 */

import { decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import type { PersistedSession } from '@/persistence';
import { captureSaycodeAgentEnvironment } from './sessionEnv';
import type { SessionEncryptionData, TrackedSession } from './types';

type HydratedFields = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'encryption' | 'userHomeDir' | 'persistedLastProcessedSeq' | 'agentEnvironment' | 'deferredContinuationContextFile'
>;

/**
 * Fields to merge into a TrackedSession that was built without them.
 *
 * Keys the record doesn't carry are omitted rather than set to undefined, so
 * the result is safe to spread over a session that already holds fresher
 * values.
 *
 * `runtime` is deliberately never produced here: the idle guard's
 * stale-runtime protection keys off its absence, so fabricating one from a
 * persisted cursor would make a silent session look freshly reported.
 */
export function hydrateTrackedSessionFromPersisted(persisted: PersistedSession | undefined): HydratedFields {
  if (!persisted) return {};
  const agentEnvironment = persisted.agentEnvironment
    ? captureSaycodeAgentEnvironment(persisted.agentEnvironment as NodeJS.ProcessEnv)
    : undefined;

  return {
    happySessionMetadataFromLocalWebhook: persisted.metadata,
    encryption: {
      encryptionKey: decodeBase64(persisted.encryptionKey),
      encryptionVariant: persisted.encryptionVariant,
      seq: persisted.seq,
      metadataVersion: persisted.metadataVersion,
      agentStateVersion: persisted.agentStateVersion,
    },
    ...(persisted.userHomeDir ? { userHomeDir: persisted.userHomeDir } : {}),
    ...(persisted.lastProcessedSeq !== undefined
      ? { persistedLastProcessedSeq: persisted.lastProcessedSeq }
      : {}),
    ...(agentEnvironment ? { agentEnvironment } : {}),
    ...(persisted.deferredContinuationContextFile
      ? { deferredContinuationContextFile: persisted.deferredContinuationContextFile }
      : {}),
  };
}

export function hydrateRecoveredSessionFromPersisted(
  persisted: PersistedSession | undefined,
  baselineSeq: number,
): Pick<TrackedSession, 'userHomeDir' | 'persistedLastProcessedSeq' | 'agentEnvironment' | 'deferredContinuationContextFile'> {
  const hydrated = hydrateTrackedSessionFromPersisted(persisted);
  return {
    ...(hydrated.userHomeDir ? { userHomeDir: hydrated.userHomeDir } : {}),
    persistedLastProcessedSeq: baselineSeq,
    ...(hydrated.agentEnvironment ? { agentEnvironment: hydrated.agentEnvironment } : {}),
    ...(hydrated.deferredContinuationContextFile
      ? { deferredContinuationContextFile: hydrated.deferredContinuationContextFile }
      : {}),
  };
}

export function mergeTrackedSessionWebhook(input: {
  tracked: TrackedSession;
  sessionId: string;
  metadata: Metadata;
  encryption?: SessionEncryptionData;
  persistedLastProcessedSeq?: number;
}): TrackedSession {
  return {
    ...input.tracked,
    happySessionId: input.sessionId,
    happySessionMetadataFromLocalWebhook: input.metadata,
    ...(input.encryption ? { encryption: input.encryption } : {}),
    ...(input.persistedLastProcessedSeq !== undefined
      ? { persistedLastProcessedSeq: input.persistedLastProcessedSeq }
      : {}),
  };
}
