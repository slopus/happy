import * as React from 'react';

/** Historical sections retain their source session for reads, but must not execute actions. */
export const TranscriptReadOnlyContext = React.createContext(false);

/** External app text keeps its existing inert Markdown policy independently of write permissions. */
export const TranscriptRestrictedContentContext = React.createContext(false);

/** Applies to direct rows and messages nested inside virtualized work groups. */
export const TranscriptMessageOptionsContext = React.createContext<{
    responses: ReadonlyMap<string, import('@/sync/messageOptionResponses').MessageOptionResponse>;
    inactive: boolean;
}>({ responses: new Map(), inactive: false });
