import * as React from 'react';
import { type v3 } from '@slopus/happy-sync';

/**
 * ReasoningPartView — renders thinking/reasoning parts.
 * Currently hidden (matches legacy behavior of hiding isThinking messages).
 */
export const ReasoningPartView = React.memo((_props: {
    part: v3.ReasoningPart;
}) => {
    // Reasoning/thinking is hidden in the UI (same as legacy AgentTextBlock with isThinking)
    return null;
});
