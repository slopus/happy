import * as React from 'react';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { Message, ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { WriteView } from './WriteView';
import { TodoView } from './TodoView';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { TaskView } from './TaskView';
import { BashViewFull } from './BashViewFull';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
    messages: Message[]
}

// Type for tool view components
export type ToolViewComponent = React.ComponentType<ToolViewProps>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    Bash: BashView,
    Write: WriteView,
    TodoWrite: TodoView,
    ExitPlanMode: ExitPlanToolView,
    MultiEdit: MultiEditView,
    Task: TaskView
};

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
    Bash: BashViewFull
};

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName] || null;
}

// Helper function to get the full view component for a tool
export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName] || null;
}

// Export individual components
export { EditView } from './EditView';
export { BashView } from './BashView';
export { BashViewFull } from './BashViewFull';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { TaskView } from './TaskView';