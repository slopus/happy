import * as React from 'react';

/** Historical sections retain their source session for reads, but must not execute actions. */
export const TranscriptReadOnlyContext = React.createContext(false);

/** External app text keeps its existing inert Markdown policy independently of write permissions. */
export const TranscriptRestrictedContentContext = React.createContext(false);
