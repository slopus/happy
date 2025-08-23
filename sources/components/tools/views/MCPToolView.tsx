import * as React from 'react';
import { ToolViewProps } from './_all';

/**
 * Converts snake_case string to PascalCase with spaces
 * Example: "create_issue" -> "Create Issue"
 */
function snakeToPascalWithSpaces(str: string): string {
    return str
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Formats MCP tool name to display title
 * Example: "mcp__linear__create_issue" -> "MCP: Linear Create Issue"
 */
function formatMCPTitle(toolName: string): string {
    // Remove "mcp__" prefix
    const withoutPrefix = toolName.replace(/^mcp__/, '');
    
    // Split into parts by "__"
    const parts = withoutPrefix.split('__');
    
    if (parts.length >= 2) {
        const serverName = snakeToPascalWithSpaces(parts[0]);
        const toolNamePart = snakeToPascalWithSpaces(parts.slice(1).join('_'));
        return `MCP: ${serverName} ${toolNamePart}`;
    }
    
    // Fallback if format doesn't match expected pattern
    return `MCP: ${snakeToPascalWithSpaces(withoutPrefix)}`;
}

/**
 * MCP Tool View Component
 * Handles all MCP tool calls by displaying a formatted title and nothing more
 */
export const MCPToolView = React.memo<ToolViewProps>(({ tool }) => {
    // This view is designed to only show the formatted title in the header
    // The actual title formatting is handled by the knownTools system
    // This component returns null to show no content area
    
    return null;
});

// Export the formatting function for use in knownTools
export { formatMCPTitle };