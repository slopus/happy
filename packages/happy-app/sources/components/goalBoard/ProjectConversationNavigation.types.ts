import type * as React from 'react';
import type { GoalProject } from '@slopus/happy-wire';
export type ProjectConversationSelection = { scopePath: string; taskId?: string; sessionId: string };
export type ProjectConversationNavigationProps = {
    children: React.ReactNode;
    project?: GoalProject;
    machineId: string;
    agent: 'codex' | 'claude';
    offline: boolean;
    revision?: string;
    selectedId?: string;
    locationKey?: string;
    onSelect: (selection: ProjectConversationSelection) => void;
};
