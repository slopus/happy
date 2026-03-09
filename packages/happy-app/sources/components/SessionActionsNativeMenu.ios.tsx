import * as React from 'react';
import { Button, ContextMenu, Host } from '@expo/ui/swift-ui';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { Session } from '@/sync/storageTypes';

interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterBugReport?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

const iosSymbol = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['systemImage'];

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

    return (
        <Host matchContents>
            <ContextMenu activationMethod="longPress">
                <ContextMenu.Items>
                    <Button onPress={openDetails} systemImage={iosSymbol('info.circle')}>
                        Details
                    </Button>
                    {canArchive && (
                        <Button onPress={archiveSession} systemImage={iosSymbol('archivebox')}>
                            Archive
                        </Button>
                    )}
                    {canShowResume && (
                        <Button onPress={resumeSession} systemImage={iosSymbol('play.circle')}>
                            Resume
                        </Button>
                    )}
                    {canBugReport && (
                        <Button onPress={reportBug} systemImage={iosSymbol('ladybug')}>
                            Bug report
                        </Button>
                    )}
                </ContextMenu.Items>
                <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
            </ContextMenu>
        </Host>
    );
}
