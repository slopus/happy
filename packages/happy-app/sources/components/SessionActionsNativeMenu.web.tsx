import * as React from 'react';
import type { SessionActionsNativeMenuHandle, SessionActionsNativeMenuProps } from './SessionActionsNativeMenu';

/** The browser has no menu to borrow — `SessionActionsPopover` serves right-click. */
export const SessionActionsNativeMenu = React.forwardRef<
    SessionActionsNativeMenuHandle,
    SessionActionsNativeMenuProps
>((props, ref) => {
    React.useImperativeHandle(ref, () => ({ open: () => {} }), []);
    return <>{props.children}</>;
});

SessionActionsNativeMenu.displayName = 'SessionActionsNativeMenu';
