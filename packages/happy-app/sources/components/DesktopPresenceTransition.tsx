import * as React from 'react';
import type { DesktopPresenceTransitionProps } from './DesktopPresenceTransition.types';

export type { DesktopPresenceTransitionProps, DesktopTransitionDirection } from './DesktopPresenceTransition.types';

export function DesktopPresenceTransition({ children }: DesktopPresenceTransitionProps) {
    return <>{children}</>;
}
