import { ToolCall } from '@/sync/typesMessage';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

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
    // Start with the raw tool name and replace colons with double underscores for consistent splitting
    const title = `${tool.name}`.replace(/__/g, ':');

    // Remove "mcp__" or "happy__" prefix if present for cleaner display
    const withoutPrefix = `${title}`.replace(/^mcp:/, '').replace(/^happy:/, '');

    // Determine prefix based on tool name
    let prefix = "MCP: ";
    if (/^orchestrator_/.test(withoutPrefix) || /^preview_html$/.test(withoutPrefix)) {
        prefix = "";
    }
    
    // Split into parts by ":" and convert to PascalCase with spaces
    const parts = withoutPrefix.split(':');
    
    if (parts.length >= 2) {
        const serverName = snakeToPascalWithSpaces(parts[0]);
        const toolNamePart = snakeToPascalWithSpaces(parts.slice(1).join('_'));
        return `${prefix}${serverName} ${toolNamePart}`;
    }
    
    // Fallback if format doesn't match expected pattern
    return `${prefix}${snakeToPascalWithSpaces(withoutPrefix)}`;
}

/**
 * Formats MCP tool call to display subtitle, e.g. showing run ID for orchestrator tools
 * Example: For a tool call with name "mcp__orchestrator_pend" and input { runId: "123" }, it returns "Run ID: 123"
 */
export function formatMCPSubtitle(tool: ToolCall): string {
    // Start with the raw tool name and replace colons with double underscores for consistent splitting
    const title = `${tool.name}`.replace(/__/g, ':');

    // Remove "mcp__" or "happy__" prefix if present for cleaner display
    const withoutPrefix = `${title}`.replace(/^mcp:/, '').replace(/^happy:/, '');

    // Special case for preview_html to use the title from input if available
    if (withoutPrefix === "preview_html" && tool.input?.title) {
        return `${tool.input.title}`;
    }

    // Show orchestrator_* tool details in subtitle if available
    if (withoutPrefix === "orchestrator_submit") {
        let subtitle = tool.input?.title || '';
        try {
            const resultText = JSON.parse(tool.result?.text || tool.result?.[0]?.text || '{}');
            if (resultText.ok === true && resultText.data?.runId) {
                if (subtitle) {
                    subtitle = `Run ID: ${resultText.data.runId} - ${subtitle}`;
                }
            }
        } catch (e) {
            // If parsing fails, just return the subtitle without run ID
        }
        if (subtitle) {
            return subtitle;
        }
        return '';
    }
    if (withoutPrefix === "orchestrator_pend" && tool.input?.runId) {
        return `Run ID: ${tool.input.runId}`;
    }
    if (withoutPrefix === "orchestrator_cancel" && tool.input?.runId) {
        return `Run ID: ${tool.input.runId}`;
    }
    if (withoutPrefix === "orchestrator_send_message" && tool.input?.taskId) {
        return `Task ID: ${tool.input.taskId}`;
    }

    return '';
}

export function formatMCPIcon(tool: ToolCall, size: number = 18, color: string = '#000', secondaryColor: string = '') {
    // Start with the raw tool name and replace colons with double underscores for consistent splitting
    const title = `${tool.name}`.replace(/__/g, ':');

    // Remove "mcp__" or "happy__" prefix if present for cleaner display
    const withoutPrefix = `${title}`.replace(/^mcp:/, '').replace(/^happy:/, '');

    // Orchestator tools get a robot icon
    if (/^orchestrator_/.test(withoutPrefix)) {
        return <MaterialCommunityIcons name="robot-outline" size={size} color={color} />;
    }

    // Preview HTML tool gets a web icon
    if (withoutPrefix === "preview_html") {
        return <Ionicons name="earth-outline" size={size} color={color} />;
    }

    // Default icon for non-MCP tools or if format is unexpected
    return <Ionicons name="extension-puzzle-outline" size={size} color={secondaryColor || color} />;
}