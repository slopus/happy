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
    } = useSessionQuickActions(session, {
        onAfterArchive,
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
                    {canCopySessionMetadata && (
                        <Button onPress={copySessionMetadata} systemImage={iosSymbol('ladybug')}>
                            {t('sessionInfo.copyMetadata')}
                        </Button>
                    )}
                </ContextMenu.Items>
                <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
            </ContextMenu>
        </Host>
    );
}
