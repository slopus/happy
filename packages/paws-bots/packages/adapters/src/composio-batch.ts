import type { ToolBatch } from "@rakazo/adapter-kit";

export const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";
const COMPOSIO_BATCH: ToolBatch = { items: "tools", action: "tool_slug", arguments: "arguments" };

/**
 * Composio runs every action through one batch tool, naming each in `tools[].tool_slug`, whether
 * its tools come from a Composio session or a Composio MCP server.
 */
export function composioToolBatch(toolName: string): ToolBatch | undefined {
  return toolName === COMPOSIO_MULTI_EXECUTE_TOOL ? COMPOSIO_BATCH : undefined;
}
