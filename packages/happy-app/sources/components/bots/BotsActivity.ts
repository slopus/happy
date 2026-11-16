import * as React from 'react';

/** Desktop navigation keeps the workspace mounted even when its route is removed. */
export const BotsActivity = React.createContext<boolean | null>(null);
