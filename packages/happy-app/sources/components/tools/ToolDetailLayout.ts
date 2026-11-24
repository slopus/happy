import * as React from 'react';

/** The dialog owns its bounds; only the active tool body reports its content height. */
export const ToolDetailContentSizeContext = React.createContext<((height: number) => void) | null>(null);
