import * as React from 'react';
import { Platform } from 'react-native';
import { useHappyAction } from './useHappyAction';
import { HappyError } from '@/utils/errors';
import { useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { PublicSessionShareState } from '@/sync/publicSessionShareTypes';
import {
    getPublicSessionShare,
    getPublicSessionShareUrl,
    revokePublicSessionShare,
} from '@/sync/apiPublicSessionShares';
import {
    cancelPublicSessionShareJob,
    enqueuePublicSessionShareJob,
    getPublicSessionShareJob,
    subscribePublicSessionShareJobs,
} from '@/sync/publicSessionShareQueueRuntime';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { PublicSessionThemePack } from '@slopus/happy-wire';
import type { PublicSessionCoverSelection } from '@/sync/publicSessionShareQueue';

export type PublicSessionSharePublishInput = {
    themePack: PublicSessionThemePack;
    coverSelection?: PublicSessionCoverSelection;
};

export function usePublicSessionShare(sessionId: string, title: string) {
    const groupToolCalls = useSetting('groupToolCalls');
    const [shareState, setShareState] = React.useState<PublicSessionShareState>({ active: false, publicId: null, publishedAt: null });
    const [checking, setChecking] = React.useState(true);
    const getQueuedJob = React.useCallback(() => getPublicSessionShareJob(sessionId), [sessionId]);
    const queuedJob = React.useSyncExternalStore(
        subscribePublicSessionShareJobs,
        getQueuedJob,
        getQueuedJob,
    );

    const credentials = sync.getCredentials();
    const refreshState = React.useCallback(async (preserveCurrentOnError: boolean) => {
        if (!credentials) {
            setChecking(false);
            return;
        }
        try {
            setShareState(await getPublicSessionShare(credentials, sessionId));
        } catch {
            if (!preserveCurrentOnError) {
                setShareState({ active: false, publicId: null, publishedAt: null });
            }
        } finally {
            setChecking(false);
        }
    }, [credentials, sessionId]);

    React.useEffect(() => {
        void refreshState(false);
    }, [refreshState]);

    const refreshedReadyJob = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (queuedJob?.status !== 'ready' || !queuedJob.publicId || !queuedJob.publishedAt) return;
        const identity = `${queuedJob.id}:${queuedJob.publishedAt}`;
        if (refreshedReadyJob.current === identity) return;
        refreshedReadyJob.current = identity;
        void refreshState(true);
    }, [queuedJob?.id, queuedJob?.publicId, queuedJob?.publishedAt, queuedJob?.status, refreshState]);

    const refresh = React.useCallback(() => refreshState(false), [refreshState]);

    const reportedWebFailureAt = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || queuedJob?.status !== 'failed' || !queuedJob.notificationPending) return;
        if (reportedWebFailureAt.current === queuedJob.updatedAt) return;
        reportedWebFailureAt.current = queuedJob.updatedAt;
        Modal.alert(t('common.error'), queuedJob.error || t('sessionShare.shareFailed'));
    }, [queuedJob?.error, queuedJob?.notificationPending, queuedJob?.status, queuedJob?.updatedAt]);

    const performPublish = React.useCallback((appearance: PublicSessionSharePublishInput): boolean => {
        if (!credentials) {
            Modal.alert(t('common.error'), t('sessionShare.authenticationUnavailable'));
            return false;
        }
        if (sync.hasPendingOutboxMessagesForSession(sessionId)) {
            Modal.alert(t('common.error'), t('sessionShare.pendingMessages'));
            return false;
        }
        const cutoffSeq = sync.getSessionLastMessageSeq(sessionId);
        if (cutoffSeq === null) {
            Modal.alert(t('common.error'), t('sessionShare.shareFailed'));
            return false;
        }
        enqueuePublicSessionShareJob({
            sessionId,
            title,
            requestedAt: Date.now(),
            cutoffSeq,
            groupToolCalls,
            themePack: appearance.themePack,
            coverSelection: appearance.coverSelection,
        });
        return true;
    }, [credentials, groupToolCalls, sessionId, title]);

    const [revoking, performRevoke] = useHappyAction(async () => {
        if (!credentials) throw new HappyError(t('sessionShare.authenticationUnavailable'), false);
        try {
            cancelPublicSessionShareJob(sessionId);
            await revokePublicSessionShare(credentials, sessionId);
            setShareState({ active: false, publicId: null, publishedAt: null });
        } catch (error) {
            throw new HappyError(error instanceof Error ? error.message : t('sessionShare.revokeFailed'), false);
        }
    });

    return {
        shareState,
        shareUrl: shareState.publicId ? getPublicSessionShareUrl(shareState.publicId) : null,
        progress: queuedJob?.progress ?? { completed: 0, total: 0 },
        checking,
        publishing: queuedJob?.status === 'queued' || queuedJob?.status === 'running',
        revoking,
        refresh,
        publish: performPublish,
        revoke: performRevoke,
    };
}
