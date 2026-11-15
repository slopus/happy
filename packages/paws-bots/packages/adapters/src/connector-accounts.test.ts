import type { ConnectedConnector, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { resolveAccountToolCall, scopeConnectorTools } from "./connector-accounts.js";
import { catalogEntries, resolveCatalogCall } from "./lazy-tool-catalog.js";

const first: ConnectedConnector = {
  id: "connection-work",
  connectorId: "example",
  externalId: "mail",
  displayName: "Work",
};
const second: ConnectedConnector = { ...first, id: "connection-home", displayName: "Home" };
const tool: ConnectorTool = {
  name: "read_messages",
  description: "Read messages",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { connected_account: { type: "string" } },
    required: ["connected_account"],
  },
};

describe("account-scoped connector tools", () => {
  it("resolves old watch names only when one account matches", () => {
    const call = { tool: tool.name, args: {}, executionId: "watch" };
    const work = scopeConnectorTools([tool], first);
    const both = [...work, ...scopeConnectorTools([tool], second)];
    expect(resolveAccountToolCall(call, work)?.call.route?.connectionId).toBe(first.id);
    expect(resolveAccountToolCall(call, both)).toBeUndefined();
    expect(
      resolveAccountToolCall({ ...call, tool: work[0]!.name }, both)?.call.route?.connectionId,
    ).toBe(first.id);
  });

  it("keeps names and routes stable when accounts are reordered, removed, or renamed", () => {
    const original = scopeConnectorTools([tool], first)[0]!;
    const sibling = scopeConnectorTools([tool], second)[0]!;
    expect(original.name).not.toBe(sibling.name);
    expect(scopeConnectorTools([tool], { ...first, displayName: "Renamed" })[0]?.name).toBe(
      original.name,
    );
    expect(original.route).toMatchObject({ connectionId: first.id, toolName: tool.name });
    expect(original.description).toContain('Connected account: "Work"');
    expect(original.inputSchema).toBe(tool.inputSchema);
    expect(original.readOnly).toBe(true);
  });

  it("resolves each lazy catalog entry to its own account without changing app arguments", () => {
    const entries = catalogEntries([
      ...scopeConnectorTools([tool], first),
      ...scopeConnectorTools([tool], second),
    ]);
    expect(new Set(entries.map(({ id }) => id)).size).toBe(2);
    for (const entry of entries) {
      const resolved = resolveCatalogCall(
        {
          tool: "execute",
          args: { id: entry.id, arguments: { connected_account: "app-value" } },
          executionId: "test",
        },
        entries,
      );
      expect(resolved.call.route?.connectionId).toBe(entry.tool.route?.connectionId);
      expect(resolved.call.args).toEqual({ connected_account: "app-value" });
    }
    expect(() =>
      resolveCatalogCall(
        { tool: "execute", args: { id: entries[0]!.id, arguments: {} }, executionId: "test" },
        entries.slice(1),
      ),
    ).toThrow();
  });

  it("retains distinct stable names for long tool names with the same prefix", () => {
    const tools = scopeConnectorTools(
      [
        tool,
        { ...tool, name: `${tool.name}${"x".repeat(60)}` },
        { ...tool, name: `${tool.name}${"x".repeat(60)}y` },
      ],
      first,
    );
    expect(new Set(tools.map(({ name }) => name)).size).toBe(3);
    expect(tools[1]?.name).toContain(`${tool.name}${"x".repeat(60)}`);
  });
});
