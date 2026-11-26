import * as React from 'react';

/** Height obscured by this conversation's floating Web composer; other transcripts use zero. */
export const ChatComposerOverlayContext = React.createContext(0);

export function useChatComposerOverlayInset() {
    return React.useContext(ChatComposerOverlayContext);
}
