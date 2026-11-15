import { createHash } from "node:crypto";
import type { ConnectedConnector, ConnectorCall, ConnectorTool } from "@rakazo/adapter-kit";

/** Older saved watches can use an action name only when it identifies one account. */
export function resolveAccountToolCall(call: ConnectorCall, tools: ConnectorTool[]) {
  const exact = tools.find((tool) => tool.name === call.tool);
  const matches = tools.filter(
    (tool) => tool.route?.connectionId && tool.route.toolName === call.tool,
  );
  const tool = exact ?? (matches.length === 1 ? matches[0] : undefined);
  return tool ? { tool, call: { ...call, tool: tool.name, route: tool.route } } : undefined;
}

/** Each account gets stable tool names and an opaque local route, even when siblings change. */
export function scopeConnectorTools(
  tools: ConnectorTool[],
  connection: ConnectedConnector,
): ConnectorTool[] {
  return tools.map((tool) => {
    const suffix = createHash("sha256")
      .update(JSON.stringify([connection.id, tool.name]))
      .digest("hex")
      .slice(0, 16);
    return {
      ...tool,
      // Keep the full action name for approval classification. Long names put the
      // account hash first so runtime name truncation cannot erase the account.
      name: tool.name.length <= 46 ? `${tool.name}__${suffix}` : `account_${suffix}__${tool.name}`,
      description: `${tool.description}\nConnected account: ${JSON.stringify(connection.displayName)} (${connection.id})`,
      route: {
        ...tool.route,
        connectorId: connection.connectorId,
        resourceId: tool.route?.resourceId ?? connection.externalId,
        toolName: tool.route?.toolName ?? tool.name,
        connectionId: connection.id,
        resourceRevision: tool.route?.resourceRevision ?? connection.providerRef,
        catalogGroup: `${connection.externalId} (${connection.displayName}; ${connection.id})`,
      },
    };
  });
}
