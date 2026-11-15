/** The same assignment policy applies to ordinary MCP calls and protocol bridges. */
export function mcpToolAllowed(
  assignment: { allowAllTools: boolean; allowedTools: unknown },
  tool: string,
): boolean {
  return (
    assignment.allowAllTools ||
    (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(tool))
  );
}
