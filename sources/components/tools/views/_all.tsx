import * as React from 'react';

import { BashView } from './BashView';
import { BashViewFull } from './BashViewFull';
import { CodexBashView } from './CodexBashView';
import { CodexDiffView } from './CodexDiffView';
import { CodexPatchView } from './CodexPatchView';
import { EditView } from './EditView';
import { EditViewFull } from './EditViewFull';
import { ExitPlanToolView } from './ExitPlanToolView';
import { MultiEditView } from './MultiEditView';
import { MultiEditViewFull } from './MultiEditViewFull';
import { TaskView } from './TaskView';
import { TodoView } from './TodoView';
import { WriteView } from './WriteView';

import { Metadata } from '@/sync/storageTypes';
import { Message, ToolCall } from '@/sync/typesMessage';

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
  CodexBash: CodexBashView,
  CodexPatch: CodexPatchView,
  CodexDiff: CodexDiffView,
  Write: WriteView,
  TodoWrite: TodoView,
  ExitPlanMode: ExitPlanToolView,
  exit_plan_mode: ExitPlanToolView,
  MultiEdit: MultiEditView,
  Task: TaskView,
};

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
  Bash: BashViewFull,
  Edit: EditViewFull,
  MultiEdit: MultiEditViewFull,
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
export { CodexBashView } from './CodexBashView';
export { CodexPatchView } from './CodexPatchView';
export { CodexDiffView } from './CodexDiffView';
export { BashViewFull } from './BashViewFull';
export { EditViewFull } from './EditViewFull';
export { MultiEditViewFull } from './MultiEditViewFull';
export { ExitPlanToolView } from './ExitPlanToolView';
export { MultiEditView } from './MultiEditView';
export { TaskView } from './TaskView';
