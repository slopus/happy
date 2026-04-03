import * as React from 'react';
import { Platform } from 'react-native';
import { Session } from '@/sync/storageTypes';

export interface SessionActionsNativeMenuProps {
    children: React.ReactNode;
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    session: Session;
}

const SessionActionsNativeMenuImpl = Platform.select<React.ComponentType<SessionActionsNativeMenuProps>>({
    ios: require('./SessionActionsNativeMenu.ios').SessionActionsNativeMenu,
    android: require('./SessionActionsNativeMenu.android').SessionActionsNativeMenu,
    default: require('./SessionActionsNativeMenu.web').SessionActionsNativeMenu,
}) ?? require('./SessionActionsNativeMenu.web').SessionActionsNativeMenu;

export function SessionActionsNativeMenu(props: SessionActionsNativeMenuProps) {
    return <SessionActionsNativeMenuImpl {...props} />;
}
