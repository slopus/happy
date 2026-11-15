import type { ConnectorTool } from "@rakazo/adapter-kit";

export const CLOUD_AGENT_TOOL_NAMES = new Set([
  "cloud_agent_launch",
  "cloud_agent_status",
  "cloud_agent_reply",
  "cloud_agent_cancel",
]);

/** Existing agents keep cleanup tools even when no connection may start work. */
export function selectCloudAgentTools(
  tools: ConnectorTool[],
  cloudAgentConfigured: boolean,
  cleanupAvailable = false,
): ConnectorTool[] {
  return cloudAgentConfigured
    ? tools
    : tools.filter(
        (tool) =>
          !CLOUD_AGENT_TOOL_NAMES.has(tool.name) ||
          (cleanupAvailable && ["cloud_agent_status", "cloud_agent_cancel"].includes(tool.name)),
      );
}
