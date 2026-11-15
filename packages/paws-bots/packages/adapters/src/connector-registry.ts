import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ComposioProvider } from "./composio-connector.js";
import { sanitizeIntegrationError } from "./composio-connector.js";

export class ConnectorRegistry implements ConnectorProvider {
  private readonly providers = new Map<string, ConnectorProvider>();

  constructor(providers: ConnectorProvider[]) {
    for (const provider of providers) {
      const id = provider.describe().id;
      if (this.providers.has(id)) throw new Error(`Duplicate connector id ${id}`);
      this.providers.set(id, provider);
    }
  }

  managedProviders(): ManagedConnectorProvider[] {
    return [...this.providers.values()].filter(isManagedConnectorProvider);
  }

  managed(id: string): ManagedConnectorProvider | undefined {
    const provider = this.providers.get(id);
    return provider && isManagedConnectorProvider(provider) ? provider : undefined;
  }

  /** Release run-scoped state of every provider that keeps it. */
  endRun(runId: string): void {
    for (const provider of this.providers.values()) provider.endRun?.(runId);
  }

  describe() {
    return {
      id: "connector-registry",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const discovered: ConnectorTool[] = [];
    const used = new Set<string>();
    const providerTools = await Promise.all(
      [...this.providers].map(async ([connectorId, provider]) => {
        try {
          return [connectorId, await provider.discoverTools(context)] as const;
        } catch (error) {
          getLogger().error("connector discovery failed", sanitizeIntegrationError(error), {
            "connector.id": connectorId,
          });
          return [connectorId, []] as const;
        }
      }),
    );
    for (const [connectorId, tools] of providerTools) {
      for (const tool of tools) {
        let name = tool.name;
        if (used.has(name)) name = `${connectorId}.${name}`;
        let suffix = 2;
        while (used.has(name)) {
          name = `${connectorId}.${tool.name}.${suffix}`;
          suffix += 1;
        }
        used.add(name);
        discovered.push({
          ...tool,
          name,
          route: tool.route ?? { connectorId, toolName: tool.name },
        });
      }
    }
    return discovered;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const connectorId = call.route?.connectorId ?? "composio";
    const provider = this.providers.get(connectorId);
    if (!provider) {
      yield { type: "error", message: `unknown connector ${connectorId}` };
      return;
    }
    const connectionId = call.route?.connectionId ?? call.connectionId;
    if (
      connectionId &&
      !context.connectedConnections?.some(
        (connection) => connection.id === connectionId && connection.connectorId === connectorId,
      )
    ) {
      yield { type: "error", message: "The selected connected account is unavailable." };
      return;
    }
    const scopedContext = connectionId
      ? {
          ...context,
          connectedConnections: context.connectedConnections!.filter(
            (connection) =>
              connection.id === connectionId && connection.connectorId === connectorId,
          ),
          connectedProviders: undefined,
        }
      : context;
    yield* provider.execute(
      { ...call, connectionId, tool: call.route?.toolName ?? call.tool },
      scopedContext,
    );
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    const connectorId = call.route?.connectorId;
    if (!connectorId) {
      for (const provider of this.providers.values()) {
        const resolved = await provider.resolveCall?.(call, context);
        if (resolved) return resolved;
      }
      return undefined;
    }
    const provider = this.providers.get(connectorId);
    return provider?.resolveCall?.({ ...call, tool: call.route?.toolName ?? call.tool }, context);
  }
}

function isManagedConnectorProvider(
  provider: ConnectorProvider,
): provider is ManagedConnectorProvider {
  const candidate = provider as Partial<ManagedConnectorProvider>;
  return (
    typeof candidate.catalog === "function" &&
    typeof candidate.begin === "function" &&
    typeof candidate.complete === "function" &&
    typeof candidate.connectionReady === "function" &&
    typeof candidate.listConnectedExternalIds === "function" &&
    typeof candidate.revoke === "function"
  );
}

export function createConnectorStack(
  composio: ComposioProvider | undefined,
  providers: ConnectorProvider[] = [],
) {
  return {
    composio,
    connector: new ConnectorRegistry([...(composio ? [composio] : []), ...providers]),
  };
}
