import * as React from 'react';
import { Button, ContextMenu, Host } from '@expo/ui/swift-ui';
import { MISSING_SESSION, useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import type { SessionActionShortcutId } from '@/keyboard/shortcuts';
import { useSession } from '@/sync/storage';
import type { SessionActionsNativeMenuHandle, SessionActionsNativeMenuProps } from './SessionActionsNativeMenu';

const iosSymbol = (name: string) =>
    name as unknown as React.ComponentProps<typeof Button>['systemImage'];

/**
 * The rows come from `useSessionQuickActions`, which names its icons in
 * Ionicons; UIMenu wants SF Symbols, so each action carries a second name here.
 */
const SYMBOLS: Record<SessionActionShortcutId, string> = {
    'archive': 'archivebox',
    'copy-metadata': 'ladybug',
    'copy-metadata-and-logs': 'doc.text',
    'details': 'info.circle',
    'duplicate': 'plus.square.on.square',
    'fork': 'arrow.triangle.branch',
    'resume': 'play.circle',
};

export const SessionActionsNativeMenu = React.forwardRef<
    SessionActionsNativeMenuHandle,
    SessionActionsNativeMenuProps
>(({ children, onAfterArchive, onAfterDelete, onBeforeArchive, sessionId }, ref) => {
    const session = useSession(sessionId);
    const { actionItems } = useSessionQuickActions(session ?? MISSING_SESSION, {
        onAfterArchive,
        onAfterDelete,
        onBeforeArchive,
    });

    // UIKit owns the long press that opens a context menu, and there is no way
    // to raise one from here — the handle exists so callers can wire the same
    // gesture on every platform.
    React.useImperativeHandle(ref, () => ({ open: () => {} }), []);

    // The session object is replaced on every token a streaming agent sends, and
    // with it every callback in `actionItems`. Rebuilding the SwiftUI host that
    // often is what used to stall the iOS list, so the buttons are rebuilt only
    // when the menu's visible content changes and the presses are dispatched
    // through a ref to the current actions.
    const itemsRef = React.useRef(actionItems);
    itemsRef.current = actionItems;
    const signature = actionItems.map((item) => `${item.id}\u0000${item.label}`).join('\u0001');
    const buttons = React.useMemo(() => itemsRef.current.map((item) => (
        <Button
            key={item.id}
            label={item.label}
            onPress={() => itemsRef.current.find((current) => current.id === item.id)?.onPress()}
            role={item.destructive ? 'destructive' : undefined}
            systemImage={iosSymbol(SYMBOLS[item.id])}
        />
    )), [signature]);

    // A session that has left the store has nothing to act on, and an empty
    // UIMenu would still open on a long press.
    if (!session) {
        return <>{children}</>;
    }

    return (
        <Host matchContents>
            <ContextMenu>
                <ContextMenu.Items>{buttons}</ContextMenu.Items>
                <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
            </ContextMenu>
        </Host>
    );
});

SessionActionsNativeMenu.displayName = 'SessionActionsNativeMenu';
