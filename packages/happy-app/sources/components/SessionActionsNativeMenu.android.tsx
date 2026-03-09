import * as React from 'react';
import { Button, ContextMenu } from '@expo/ui/jetpack-compose';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterBugReport?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

const androidIcon = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['leadingIcon'];

export function SessionActionsNativeMenu({
    children,
    onAfterArchive,
    onAfterBugReport,
    onAfterDelete,
    session,
}: SessionActionsNativeMenuProps) {
    const {
        archiveSession,
        canArchive,
        canBugReport,
        canShowResume,
        openDetails,
        reportBug,
        resumeSession,
    } = useSessionQuickActions(session, {
        onAfterArchive,
        onAfterBugReport,
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

    if (canBugReport) {
        items.push(
            <Button
                key="bug-report"
                leadingIcon={androidIcon('outlined.BugReport')}
                onPress={reportBug}
            >
                Bug report
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
