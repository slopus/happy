import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

export function ProjectConversationActions({ id, onRemoved, disabled, testIDPrefix }: { id: string; onRemoved: () => void; disabled?: boolean; testIDPrefix: string }) {
    const session = useSession(id);
    return session && !isSessionArchived(session) ? <Actions session={session} onRemoved={onRemoved} disabled={disabled} testIDPrefix={testIDPrefix} /> : null;
}
function Actions({ session, onRemoved, disabled, testIDPrefix }: { session: Session; onRemoved: () => void; disabled?: boolean; testIDPrefix: string }) {
    const { theme } = useUnistyles();
    const actions = useSessionQuickActions(session, { onAfterArchive: onRemoved, onAfterDelete: onRemoved });
    const busy = disabled || actions.archivingSession || actions.deletingSession || actions.restoringSession;
    return <>
        <Button variant="toolbar" label={t('sessionInfo.deleteSession')} disabled={busy} testID={`${testIDPrefix}-delete-conversation`} onPress={actions.deleteSession}><Ionicons name="trash-outline" size={20} color={theme.colors.textSecondary} /></Button>
        <Button variant="toolbar" label={t('sessionInfo.archiveSession')} disabled={busy} testID={`${testIDPrefix}-archive-conversation`} onPress={actions.archiveSession}><Ionicons name="archive-outline" size={20} color={theme.colors.textSecondary} /></Button>
    </>;
}
