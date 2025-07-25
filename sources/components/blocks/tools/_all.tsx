import * as React from 'react';
import { ReadView } from './ReadView';
import { EditView } from './EditView';
import { BashView } from './BashView';
import { ToolCall } from '@/sync/typesMessage';

// Type for tool view components
export type ToolViewComponent = React.ComponentType<{
    tool: ToolCall
}>;

// Registry of tool-specific view components
export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Read: ReadView,
    Edit: EditView,
    Bash: BashView,
    // Add more tool views here as they are created
};

// Helper function to get the appropriate view component for a tool
export function getToolViewComponent(toolName: string): ToolViewComponent | null {
    return toolViewRegistry[toolName] || null;
}

// Export individual components
export { ReadView } from './ReadView';
export { EditView } from './EditView';
export { BashView } from './BashView';