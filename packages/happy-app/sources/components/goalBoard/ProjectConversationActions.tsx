import * as React from 'react';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { isSessionArchived } from '@/utils/sessionLifecycle';
import { t } from '@/text';
import { GoalBoardButton as Button } from './GoalBoardButton';

export function ProjectConversationActions({ id, onRemoved, disabled, testIDPrefix, showLabels, onBeforeAction, render }: { id: string; onRemoved: () => void; disabled?: boolean; testIDPrefix: string; showLabels?: boolean; onBeforeAction?: () => void; render?: (actions: React.ReactNode) => React.ReactNode }) {
    const session = useSession(id);
    return session && !isSessionArchived(session) ? <Actions session={session} onRemoved={onRemoved} disabled={disabled} testIDPrefix={testIDPrefix} showLabels={showLabels} onBeforeAction={onBeforeAction} render={render} /> : render?.(null) ?? null;
}
function Actions({ session, onRemoved, disabled, testIDPrefix, showLabels, onBeforeAction, render }: { session: Session; onRemoved: () => void; disabled?: boolean; testIDPrefix: string; showLabels?: boolean; onBeforeAction?: () => void; render?: (actions: React.ReactNode) => React.ReactNode }) {
    const { theme } = useUnistyles();
    const actions = useSessionQuickActions(session, { onAfterArchive: onRemoved, onAfterDelete: onRemoved });
    const busy = disabled || actions.archivingSession || actions.deletingSession || actions.restoringSession;
    const buttons = <>
        <Button variant={showLabels ? "row" : "toolbar"} touchTarget={showLabels} label={t('sessionInfo.deleteSession')} disabled={busy} testID={`${testIDPrefix}-delete-conversation`} onPress={() => { onBeforeAction?.(); void actions.deleteSession(); }}><Ionicons name="trash-outline" size={20} color={theme.colors.textSecondary} />{showLabels && <Text style={{ color: theme.colors.text }}>{t('sessionInfo.deleteSession')}</Text>}</Button>
        <Button variant={showLabels ? "row" : "toolbar"} touchTarget={showLabels} label={t('sessionInfo.archiveSession')} disabled={busy} testID={`${testIDPrefix}-archive-conversation`} onPress={() => { onBeforeAction?.(); void actions.archiveSession(); }}><Ionicons name="archive-outline" size={20} color={theme.colors.textSecondary} />{showLabels && <Text style={{ color: theme.colors.text }}>{t('sessionInfo.archiveSession')}</Text>}</Button>
    </>;
    return render ? render(buttons) : buttons;
}
