import * as React from 'react';
import { Button, ContextMenu } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

const androidIcon = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['leadingIcon'];

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

    const items: Array<React.ReactElement<React.ComponentProps<typeof Button>>> = [
        <Button key="details" leadingIcon={androidIcon('outlined.Info')} onPress={openDetails}>
            Details
        </Button>,
    ];

    if (canArchive) {
        items.push(
            <Button
                key="archive"
                leadingIcon={androidIcon('outlined.Archive')}
                onPress={archiveSession}
            >
                Archive
            </Button>,
        );
    }

    if (canShowResume) {
        items.push(
            <Button
                key="resume"
                leadingIcon={androidIcon('outlined.PlayCircle')}
                onPress={resumeSession}
            >
                Resume
            </Button>,
        );
    }

    if (canCopySessionMetadata) {
        items.push(
            <Button
                key="copy-session-metadata"
                leadingIcon={androidIcon('outlined.BugReport')}
                onPress={copySessionMetadata}
            >
                {t('sessionInfo.copyMetadata')}
            </Button>,
        );
    }

    return (
        <ContextMenu>
            <ContextMenu.Items>{items}</ContextMenu.Items>
            <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
        </ContextMenu>
    );
}
