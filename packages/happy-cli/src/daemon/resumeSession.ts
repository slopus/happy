import type { Metadata } from '@/api/types';
import type { SessionEncryptionData, TrackedSession } from './types';
import type {
    ResumeSessionOptions,
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/modules/common/registerCommonHandlers';
import { buildResumeFallbackSpawnOptions } from './resumeFallback';

type ResumeTrackedSession = (
    sessionId: string,
    tracked: TrackedSession & { encryption: SessionEncryptionData },
    metadata: Metadata,
    options: ResumeSessionOptions | undefined,
) => Promise<SpawnSessionResult>;

export function createResumeSessionHandler({
    findTrackedSessionById,
    refreshMetadata,
    resumeTrackedSession,
    spawnSession,
    logFallback,
}: {
    findTrackedSessionById: (sessionId: string) => TrackedSession | undefined;
    refreshMetadata: (sessionId: string, tracked: TrackedSession) => Promise<Metadata | null>;
    resumeTrackedSession: ResumeTrackedSession;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    logFallback?: (reason: string) => void;
}) {
    return async (
        happySessionId: string,
        options?: ResumeSessionOptions,
    ): Promise<SpawnSessionResult> => {
        const resumeAsFreshHappySession = (reason: string): Promise<SpawnSessionResult> | null => {
            const fallback = buildResumeFallbackSpawnOptions(options);
            if (!fallback) {
                return null;
            }
            logFallback?.(reason);
            return spawnSession(fallback);
        };

        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
            const fallback = resumeAsFreshHappySession(`Session ${happySessionId} is not locally tracked`);
            if (fallback) return fallback;
            return { type: 'error', errorMessage: `Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon or on another machine.` };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
            const fallback = resumeAsFreshHappySession(`Session ${happySessionId} has no locally stored metadata`);
            if (fallback) return fallback;
            return { type: 'error', errorMessage: `Session ${happySessionId} has no metadata. Cannot resume.` };
        }
        if (!tracked.encryption) {
            const fallback = resumeAsFreshHappySession(`Session ${happySessionId} has no locally stored reconnect key`);
            if (fallback) return fallback;
            return { type: 'error', errorMessage: `Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.` };
        }

        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
            || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
            const serverMetadata = await refreshMetadata(happySessionId, tracked);
            if (serverMetadata) {
                metadata = serverMetadata;
                tracked.happySessionMetadataFromLocalWebhook = serverMetadata;
            }
        }

        if (!metadata.claudeSessionId && !metadata.codexThreadId) {
            const fallback = resumeAsFreshHappySession(`Session ${happySessionId} is missing its locally stored provider session ID`);
            if (fallback) return fallback;
        }

        return resumeTrackedSession(
            happySessionId,
            tracked as TrackedSession & { encryption: SessionEncryptionData },
            metadata,
            options,
        );
    };
}
