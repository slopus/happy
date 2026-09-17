import * as React from 'react';
import { DropdownMenu, DropdownMenuItem, Text as ComposeText } from '@expo/ui/jetpack-compose';
import { MISSING_SESSION, useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { useSession } from '@/sync/storage';
import type { SessionActionsNativeMenuHandle, SessionActionsNativeMenuProps } from './SessionActionsNativeMenu';

export const SessionActionsNativeMenu = React.forwardRef<
    SessionActionsNativeMenuHandle,
    SessionActionsNativeMenuProps
>(({ children, onAfterArchive, onAfterDelete, onBeforeArchive, sessionId }, ref) => {
    const session = useSession(sessionId);
    const [expanded, setExpanded] = React.useState(false);
    const close = React.useCallback(() => setExpanded(false), []);
    const { actionItems } = useSessionQuickActions(session ?? MISSING_SESSION, {
        onAfterArchive,
        onAfterDelete,
        onBeforeArchive,
    });

    // Compose only renders the trigger; the menu opens when `expanded` says so,
    // so the gesture has to come from the caller.
    React.useImperativeHandle(ref, () => ({
        open: () => setExpanded(true),
    }), []);

    // Nothing to act on once the session is gone.
    if (!session) {
        return <>{children}</>;
    }

    return (
        <DropdownMenu expanded={expanded} onDismissRequest={close}>
            <DropdownMenu.Items>
                {actionItems.map((item) => (
                    <DropdownMenuItem
                        key={item.id}
                        onClick={() => {
                            close();
                            item.onPress();
                        }}
                    >
                        {/* Native slot view: a bare string child throws "Text strings
                            must be rendered within a <Text> component" mid-render.
                            Compose's own Text turns it into the native `text` prop. */}
                        <DropdownMenuItem.Text>
                            <ComposeText>{item.label}</ComposeText>
                        </DropdownMenuItem.Text>
                    </DropdownMenuItem>
                ))}
            </DropdownMenu.Items>
            <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
        </DropdownMenu>
    );
});

SessionActionsNativeMenu.displayName = 'SessionActionsNativeMenu';
