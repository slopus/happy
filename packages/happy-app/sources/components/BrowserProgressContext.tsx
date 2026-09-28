import * as React from 'react';
import type { BrowserStepRun } from './rightPanel/browserStepRunsModel';

/** One projection per transcript, shared by collapsed and expanded Skill rows. */
export const BrowserProgressContext = React.createContext<{
    sessionId?: string;
    scopeKey?: string;
    runs: BrowserStepRun[];
} | null>(null);
