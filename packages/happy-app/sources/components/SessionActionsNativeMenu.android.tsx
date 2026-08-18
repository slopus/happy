import * as React from 'react';
import { DropdownMenu, DropdownMenuItem } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

export function SessionActionsNativeMenu({
    children,
    onAfterArchive,
    onAfterDelete,
    session,
}: SessionActionsNativeMenuProps) {
    const {
        archiveSession,
        canArchive,
        canCopySessionMetadata,
        canShowResume,
        canStop,
        copySessionMetadata,
        deleteSession,
        openDetails,
        resumeSession,
        stopSession,
        togglePinned,
        unarchiveSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    const isPinned = typeof session.metadata?.pinnedAt === 'number';

    return (
        <DropdownMenu>
            <DropdownMenu.Items>
                <DropdownMenuItem onClick={openDetails}>
                    <DropdownMenuItem.Text>{t('profile.details')}</DropdownMenuItem.Text>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={togglePinned}>
                    <DropdownMenuItem.Text>{isPinned ? t('sidebar.unpin') : t('sidebar.pin')}</DropdownMenuItem.Text>
                </DropdownMenuItem>
                {canStop && (
                    <DropdownMenuItem onClick={stopSession}>
                        <DropdownMenuItem.Text>{t('sessionInfo.stopSession')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canArchive ? (
                    <DropdownMenuItem onClick={archiveSession}>
                        <DropdownMenuItem.Text>{t('sessionInfo.archiveSession')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem onClick={unarchiveSession}>
                        <DropdownMenuItem.Text>{t('sessionInfo.unarchiveSession')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canShowResume && (
                    <DropdownMenuItem onClick={resumeSession}>
                        <DropdownMenuItem.Text>{t('sessionInfo.resumeSession')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                {canCopySessionMetadata && (
                    <DropdownMenuItem onClick={copySessionMetadata}>
                        <DropdownMenuItem.Text>{t('sessionInfo.copyMetadata')}</DropdownMenuItem.Text>
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={deleteSession}>
                    <DropdownMenuItem.Text>{t('sessionInfo.deleteSession')}</DropdownMenuItem.Text>
                </DropdownMenuItem>
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
}
