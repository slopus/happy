import * as React from 'react';
import { Platform } from 'react-native';

export interface SessionActionsNativeMenuHandle {
    /**
     * Opens the menu on the platforms that have to be asked. iOS owns the long
     * press itself through `UIContextMenu`, so there it does nothing — callers
     * can wire this to `onLongPress` unconditionally.
     */
    open: () => void;
}

export interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    /** Runs on the press, before the archive is attempted. See `useSessionQuickActions`. */
    onBeforeArchive?: () => void;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    sessionId: string;
}

const SessionActionsNativeMenuImpl = Platform.select<
    React.ComponentType<SessionActionsNativeMenuProps & React.RefAttributes<SessionActionsNativeMenuHandle>>
>({
    ios: require('./SessionActionsNativeMenu.ios').SessionActionsNativeMenu,
    android: require('./SessionActionsNativeMenu.android').SessionActionsNativeMenu,
    default: require('./SessionActionsNativeMenu.web').SessionActionsNativeMenu,
}) ?? require('./SessionActionsNativeMenu.web').SessionActionsNativeMenu;

/**
 * The platform's own menu around whatever it wraps — `UIMenu` through SwiftUI's
 * `ContextMenu` on iOS, a Compose `DropdownMenu` on Android. Both are filled
 * from `useSessionQuickActions`, so the rows and their translations are the ones
 * the web popover shows.
 *
 * On the web it renders the child alone: there is no system menu to borrow, and
 * right-click is served by `SessionActionsPopover`.
 */
export const SessionActionsNativeMenu = React.forwardRef<
    SessionActionsNativeMenuHandle,
    SessionActionsNativeMenuProps
>((props, ref) => <SessionActionsNativeMenuImpl {...props} ref={ref} />);

SessionActionsNativeMenu.displayName = 'SessionActionsNativeMenu';
