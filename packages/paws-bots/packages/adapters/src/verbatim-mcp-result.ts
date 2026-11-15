import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { catalogExecuteToolName } from "./approval-effect.js";
import { GROUP_SEPARATORS } from "./lazy-tool-catalog.js";

/** Servers whose tool results must stay whole. Ids cover catalog ids; slugs cover tool names. */
export type VerbatimMcpServers = NonNullable<AgentRunRequest["verbatimMcpServers"]>;

const CATALOG_EXECUTE = catalogExecuteToolName("mcp");

export function toolCallIdentity(
  call: unknown,
  fallbackName?: string,
): { name?: string; arguments?: unknown } {
  if (!call || typeof call !== "object") return { name: fallbackName };
  const record = call as { name?: unknown; arguments?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : fallbackName,
    arguments: record.arguments,
  };
}

/** Matches by prefix because slugs may contain `__` and catalog calls accept several id forms. */
export function isVerbatimMcpResult(
  name: string | undefined,
  args: unknown,
  servers: VerbatimMcpServers | undefined,
): boolean {
  if (!servers || !name) return false;
  const direct = (id: string) => servers.slugs.some((slug) => id.startsWith(`mcp__${slug}__`));
  if (name.startsWith("mcp__")) return direct(name);
  if (name !== CATALOG_EXECUTE) return false;
  const id =
    args && typeof args === "object" && "id" in args && typeof args.id === "string"
      ? args.id.trim()
      : "";
  return (
    direct(id) ||
    servers.ids.some((serverId) => id.startsWith(`${serverId}:`)) ||
    servers.slugs.some((slug) =>
      GROUP_SEPARATORS.some((separator) => id.toLowerCase().startsWith(`${slug}${separator}`)),
    )
  );
}
