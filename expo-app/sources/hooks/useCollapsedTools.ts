import * as React from 'react';
import { isMutableTool } from '@/components/tools/knownTools';

/**
 * Hook to manage collapsed state for tools.
 * Stores state in a Set that persists across component re-mounts.
 * This is needed because FlatList may recycle/re-mount ToolView components.
 *
 * Mutable tools (Edit, Write, Bash, etc.) are collapsed by default.
 */

// Global set to store collapsed tool IDs
const collapsedToolIds = new Set<string>();

// Global set to track tools that have been initialized
// Used to determine if we should apply default collapsed state
const initializedToolIds = new Set<string>();

// Listeners for state changes
const listeners = new Set<() => void>();

// Listeners for collapse events (used by ChatList to preserve scroll)
const collapseListeners = new Set<(isCollapsing: boolean) => void>();

function notifyListeners() {
    listeners.forEach(listener => listener());
}

function notifyCollapseListeners(isCollapsing: boolean) {
    collapseListeners.forEach(listener => listener(isCollapsing));
}

/**
 * Extract tool name from toolId
 * toolId format: "messageId-toolName" or "sessionId-toolName-createdAt"
 */
function extractToolName(toolId: string): string {
    // Try to extract tool name from the ID
    // Format 1: "messageId-toolName" where messageId is UUID-like
    // Format 2: "sessionId-toolName-createdAt"
    const parts = toolId.split('-');

    // Common tool names to look for
    const knownToolNames = [
        'Task', 'Bash', 'Glob', 'Grep', 'LS', 'Read', 'Edit', 'MultiEdit', 'Write',
        'WebFetch', 'NotebookRead', 'NotebookEdit', 'TodoWrite', 'WebSearch',
        'CodexBash', 'CodexReasoning', 'CodexPatch', 'CodexDiff',
        'GeminiReasoning', 'GeminiBash', 'GeminiPatch', 'GeminiDiff',
        'ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion',
        'read', 'edit', 'shell', 'execute', 'search', 'think', 'change_title'
    ];

    for (const name of knownToolNames) {
        if (toolId.includes(`-${name}-`) || toolId.endsWith(`-${name}`)) {
            return name;
        }
    }

    // Fallback: return last non-numeric part
    return parts[parts.length - 1] || '';
}

export function useCollapsedTool(toolId: string): [boolean, () => void] {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    // Subscribe to changes
    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => {
            listeners.delete(forceUpdate);
        };
    }, []);

    // Initialize collapse state for mutable tools (default to collapsed)
    if (!initializedToolIds.has(toolId)) {
        initializedToolIds.add(toolId);
        const toolName = extractToolName(toolId);
        if (isMutableTool(toolName)) {
            // Mutable tools default to collapsed
            collapsedToolIds.add(toolId);
        }
    }

    const isCollapsed = collapsedToolIds.has(toolId);

    const toggleCollapsed = React.useCallback(() => {
        const willCollapse = !collapsedToolIds.has(toolId);

        // Notify before state change (for scroll position preservation)
        notifyCollapseListeners(willCollapse);

        if (collapsedToolIds.has(toolId)) {
            collapsedToolIds.delete(toolId);
        } else {
            collapsedToolIds.add(toolId);
        }
        notifyListeners();
    }, [toolId]);

    return [isCollapsed, toggleCollapsed];
}

/**
 * Hook to listen for collapse events.
 * Used by ChatList to preserve scroll position.
 */
export function useCollapseListener(callback: (isCollapsing: boolean) => void) {
    React.useEffect(() => {
        collapseListeners.add(callback);
        return () => {
            collapseListeners.delete(callback);
        };
    }, [callback]);
}
