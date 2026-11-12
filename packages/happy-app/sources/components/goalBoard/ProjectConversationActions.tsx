import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

export function ProjectConversationActions({ id, onClose, disabled, testIDPrefix }: { id: string; onClose: () => void; disabled?: boolean; testIDPrefix: string }) {
    const session = useSession(id);
    return session ? <Actions session={session} onClose={onClose} disabled={disabled} testIDPrefix={testIDPrefix} /> : null;
}
function Actions({ session, onClose, disabled, testIDPrefix }: { session: Session; onClose: () => void; disabled?: boolean; testIDPrefix: string }) {
    const { theme } = useUnistyles();
    const actions = useSessionQuickActions(session, { onAfterArchive: onClose, onAfterDelete: onClose });
    const archived = isSessionArchived(session);
    const busy = disabled || actions.archivingSession || actions.deletingSession || actions.restoringSession;
    return <Button variant="toolbar" label={t('sessionSearch.actions.more')} disabled={busy} testID={`${testIDPrefix}-conversation-actions`} onPress={() => Modal.alert(getSessionName(session), undefined, [
        { text: t(archived ? 'sessionInfo.restoreSession' : 'sessionInfo.archiveSession'), onPress: archived ? actions.restoreSession : actions.archiveSession },
        { text: t('sessionInfo.deleteSession'), style: 'destructive', onPress: actions.deleteSession },
        { text: t('common.cancel'), style: 'cancel' },
    ])}><Ionicons name="ellipsis-horizontal" size={18} color={theme.colors.textSecondary} /></Button>;
}
