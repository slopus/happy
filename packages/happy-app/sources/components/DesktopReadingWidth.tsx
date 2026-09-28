import * as React from 'react';
import { layout } from './layout';

/** Session-scoped width so other screens keep their existing layout. */
export const DesktopReadingWidthContext = React.createContext(layout.maxWidth);

export const useDesktopReadingWidth = () => React.useContext(DesktopReadingWidthContext);
