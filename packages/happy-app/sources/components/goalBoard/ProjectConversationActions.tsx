import * as React from 'react';
import { Platform, Text, type View } from 'react-native';
import { SessionDeleteConfirmation } from '@/components/SessionDeleteConfirmation';
import type { SessionActionsAnchor } from '@/components/SessionActionsPopover';
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
    const deleteButton = React.useRef<View>(null);
    const [confirmation, setConfirmation] = React.useState<{ sessionId: string; anchor: SessionActionsAnchor } | null>(null);
    React.useEffect(() => setConfirmation(null), [session.id]);
    const cancelDelete = React.useCallback(() => setConfirmation(null), []);
    const busy = disabled || actions.archivingSession || actions.deletingSession || actions.restoringSession;
    const requestDelete = () => {
        if (busy) return;
        if (Platform.OS === 'web' && !showLabels) {
            deleteButton.current?.measureInWindow((x, y, width, height) => {
                setConfirmation({ sessionId: session.id, anchor: { type: 'rect', x, y, width, height } });
            });
            return;
        }
        onBeforeAction?.();
        void actions.deleteSession();
    };
    const buttons = <>
        <Button ref={deleteButton} variant={showLabels ? "row" : "toolbar"} touchTarget={showLabels} label={t('sessionInfo.deleteSession')} disabled={busy} testID={`${testIDPrefix}-delete-conversation`} onPress={requestDelete}><Ionicons name="trash-outline" size={20} color={theme.colors.textSecondary} />{showLabels && <Text style={{ color: theme.colors.text }}>{t('sessionInfo.deleteSession')}</Text>}</Button>
        <Button variant={showLabels ? "row" : "toolbar"} touchTarget={showLabels} label={t('sessionInfo.archiveSession')} disabled={busy} testID={`${testIDPrefix}-archive-conversation`} onPress={() => { onBeforeAction?.(); void actions.archiveSession(); }}><Ionicons name="archive-outline" size={20} color={theme.colors.textSecondary} />{showLabels && <Text style={{ color: theme.colors.text }}>{t('sessionInfo.archiveSession')}</Text>}</Button>
    </>;
    return <>
        {render ? render(buttons) : buttons}
        {confirmation?.sessionId === session.id && !busy ? <SessionDeleteConfirmation
            key={session.id} anchor={confirmation.anchor} onCancel={cancelDelete} onConfirm={() => {
                cancelDelete();
                onBeforeAction?.();
                actions.confirmDeleteSession();
            }} /> : null}
    </>;
}
