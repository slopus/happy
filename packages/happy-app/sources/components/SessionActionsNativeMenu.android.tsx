import * as React from 'react';
import { ContextMenu, Button } from '@expo/ui/jetpack-compose';
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
        copySessionMetadata,
        openDetails,
        resumeSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterDelete,
    });

    const items: React.ReactElement[] = [
        <Button key="details" onPress={openDetails}>Details</Button>,
    ];
    if (canArchive) {
        items.push(<Button key="archive" onPress={archiveSession}>Archive</Button>);
    }
    if (canShowResume) {
        items.push(<Button key="resume" onPress={resumeSession}>Resume</Button>);
    }
    if (canCopySessionMetadata) {
        items.push(<Button key="copy" onPress={copySessionMetadata}>{t('sessionInfo.copyMetadata')}</Button>);
    }

    return (
        <ContextMenu>
            <ContextMenu.Items>{items as any}</ContextMenu.Items>
            <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        </ContextMenu>
    );
}
