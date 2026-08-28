import * as React from 'react';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { knownTools } from './knownTools';
import { getToolSummaryCategory, ToolSummaryCategory } from '@/utils/toolDisplay';

/**
 * The icon for a whole run of tool calls that share one category.
 */
export function ToolCategoryIcon(props: {
    category: ToolSummaryCategory;
    color: string;
    size?: number;
}) {
    const size = props.size ?? 12;
    switch (props.category) {
        case 'terminal':
            return <Octicons name="terminal" size={size} color={props.color} />;
        case 'edit':
            return <Octicons name="file-diff" size={size} color={props.color} />;
        case 'read':
            return <Octicons name="eye" size={size} color={props.color} />;
        case 'search':
            return <Octicons name="search" size={size} color={props.color} />;
        case 'web':
            return <Ionicons name="globe-outline" size={size + 1} color={props.color} />;
        case 'task':
            return <Octicons name="rocket" size={size} color={props.color} />;
        default:
            return <Ionicons name="construct-outline" size={size + 1} color={props.color} />;
    }
}

/**
 * The icon for a single tool call. Both the expanded card (`ToolView`) and the
 * collapsed activity row (`ToolGroupView`) resolve it here, so a tool never
 * changes its icon just because a group folded around it.
 *
 * Precedence: the Codex command classifier, then the MCP namespace, then a
 * `knownTools` entry, then the tool's activity category. Only tools we know
 * nothing about reach the generic wrench.
 */
export function ToolIcon(props: {
    tool: Pick<ToolCall, 'name' | 'input'>;
    color: string;
    size?: number;
}) {
    const { tool } = props;
    const size = props.size ?? 12;

    // Codex reports what a shell command actually did, so a `grep` reads as a
    // read and an `apply_patch` as an edit rather than as a bare terminal row.
    if (tool.name === 'CodexBash' && Array.isArray(tool.input?.parsed_cmd)) {
        const parsedType = tool.input.parsed_cmd[0]?.type;
        if (parsedType === 'read') {
            return <Octicons name="eye" size={size} color={props.color} />;
        }
        if (parsedType === 'write') {
            return <Octicons name="file-diff" size={size} color={props.color} />;
        }
        return <Octicons name="terminal" size={size} color={props.color} />;
    }

    if (tool.name.startsWith('mcp__')) {
        return <Ionicons name="extension-puzzle-outline" size={size} color={props.color} />;
    }

    const known = knownTools[tool.name as keyof typeof knownTools] as
        { icon?: (size: number, color: string) => React.ReactNode } | undefined;
    if (known && typeof known.icon === 'function') {
        return <>{known.icon(size, props.color)}</>;
    }

    return (
        <ToolCategoryIcon
            category={getToolSummaryCategory(tool.name)}
            color={props.color}
            size={size}
        />
    );
}
