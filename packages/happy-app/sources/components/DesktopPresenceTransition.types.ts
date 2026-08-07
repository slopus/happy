import type * as React from 'react';

export type DesktopTransitionDirection = 'forward' | 'back';

export type DesktopPresenceTransitionProps = {
    children: React.ReactNode | null;
    direction: DesktopTransitionDirection;
    immediate?: boolean;
    testID: string;
    transitionKey: string;
};
