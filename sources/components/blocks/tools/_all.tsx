import * as React from 'react';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { ToolCall } from '@/sync/typesMessage';
import { Metadata } from '@/sync/storageTypes';
import { WriteView } from './WriteView';
import { TodoView } from './TodoView';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { TaskView } from './TaskView';

export type ToolViewProps = {
    tool: ToolCall;
    metadata: Metadata | null;
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

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName] || null;
}

// Export individual components
export { EditView } from './EditView';
export { BashView } from './BashView';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { TaskView } from './TaskView';