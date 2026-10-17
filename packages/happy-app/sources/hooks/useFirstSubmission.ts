import * as React from 'react';
import { firstSubmission, traceFirstSubmissionNavigation } from '@/sync/firstSubmissionRuntime';
import { getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { ensureSessionHydratedWithRetry } from '@/sync/ensureSessionHydratedWithRetry';
import { useNavigateToSession } from './useNavigateToSession';
import type { SpawnSessionArgs } from './useSpawnSession';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { getServerUrl } from '@/sync/serverConfig';
import { Modal } from '@/modal';
import { t } from '@/text';

export function useFirstSubmission() {
    const pending = React.useSyncExternalStore(firstSubmission.subscribe, firstSubmission.getSnapshot, firstSubmission.getSnapshot);
    const navigate = useNavigateToSession();
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    React.useEffect(() => {
        if (pending?.phase !== 'ready' || !pending.sessionId) return;
        const scope = getFirstSubmissionScope();
        void firstSubmission.dismiss(pending).then(cleared => {
            if (cleared && mounted.current && scope && scope === getFirstSubmissionScope() && getServerUrl() === scope.serverUrl) {
                traceFirstSubmissionNavigation(pending.sessionId!);
                navigate(pending.sessionId!);
            }
        });
    }, [pending, navigate]);
    const submit = React.useCallback((args: SpawnSessionArgs, text: string, released: () => void, accepted: () => void) => {
        const { machine, images, environmentVariables, ...input } = args;
        const directory = args.worktreeKey && !['__none__', '__new__'].includes(args.worktreeKey)
            ? args.worktreeKey : resolveAbsolutePath(args.path?.trim() || '~', machine.metadata?.homeDir);
        const scope = getFirstSubmissionScope();
        return firstSubmission.submit({ ...input, text, attachments: (images ?? []).map(({ id, name }) => ({ id, name })) },
            { images: images ?? [], directory, environmentVariables, released, accepted,
                replacementSaveFailed: () => {
                    if (mounted.current && scope && scope === getFirstSubmissionScope() && getServerUrl() === scope.serverUrl) {
                        Modal.alert(t('common.error'), t('newSession.submissionSaveFailed'));
                    }
                } });
    }, []);
    const checkSession = React.useCallback(async () => {
        const snapshot = firstSubmission.getSnapshot(); const scope = getFirstSubmissionScope();
        const current = () => scope !== null && scope === getFirstSubmissionScope() && getServerUrl() === scope.serverUrl;
        if (snapshot?.sessionId && await ensureSessionHydratedWithRetry(snapshot.sessionId, current)
            && mounted.current && current() && firstSubmission.getSnapshot() === snapshot) navigate(snapshot.sessionId);
    }, [navigate]);
    const dismiss = React.useCallback(async () => {
        if (!pending || pending !== firstSubmission.getSnapshot() || !['failed', 'restored'].includes(pending.phase)) return;
        const scope = getFirstSubmissionScope();
        if (!await firstSubmission.dismiss(pending) && mounted.current && scope && scope === getFirstSubmissionScope()
            && getServerUrl() === scope.serverUrl) {
            Modal.alert(t('common.error'), t('newSession.submissionDismissFailed'));
        }
    }, [pending]);
    return { pending, submit, retry: () => firstSubmission.retry(pending),
        restore: (text: string, omitAttachments: boolean) => firstSubmission.restore(text, omitAttachments ? [] : pending?.attachments ?? [], pending), checkSession, dismiss };
}
