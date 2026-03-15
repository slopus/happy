import { ToolCall } from '@/sync/typesMessage';

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
export function formatMCPTitle(tool: ToolCall): string {
    // Remove "mcp__" prefix
    const withoutPrefix = tool.name.replace(/^mcp__/, '');

    // If tool has input title, use it directly
    if (tool.input?.title) {
        if (withoutPrefix === "happy__preview_html") {
            return `${tool.input.title}`;
        } else {
            return `MCP: ${tool.input.title}`;
        }
    }
    
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