import * as React from 'react';
import { Button, ContextMenu, Host } from '@expo/ui/swift-ui';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

const iosSymbol = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['systemImage'];

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
        copySessionMetadata,
        openDetails,
        resumeSession,
        togglePinned,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    const isPinned = typeof session.metadata?.pinnedAt === 'number';

    return (
        <Host matchContents>
            <ContextMenu>
                <ContextMenu.Items>
                    <Button onPress={openDetails} systemImage={iosSymbol('info.circle')} label={t('profile.details')} />
                    <Button onPress={togglePinned} systemImage={iosSymbol(isPinned ? 'pin.slash' : 'pin')} label={isPinned ? t('sidebar.unpin') : t('sidebar.pin')} />
                    {canArchive && (
                        <Button onPress={archiveSession} systemImage={iosSymbol('archivebox')} label={t('sessionInfo.archiveSession')} />
                    )}
                    {canShowResume && (
                        <Button onPress={resumeSession} systemImage={iosSymbol('play.circle')} label={t('sessionInfo.resumeSession')} />
                    )}
                    {canCopySessionMetadata && (
                        <Button onPress={copySessionMetadata} systemImage={iosSymbol('ladybug')} label={t('sessionInfo.copyMetadata')} />
                    )}
                </ContextMenu.Items>
                <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
            </ContextMenu>
        </Host>
    );
}
