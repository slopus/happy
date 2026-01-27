import { AGENTS, type AgentCatalogEntry, type CatalogAgentId } from './catalog';

export async function registerCatalogBackends(opts?: Readonly<{ agentIds?: ReadonlyArray<CatalogAgentId> }>): Promise<void> {
  const ids = opts?.agentIds ? new Set(opts.agentIds) : null;

  for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
    if (ids && !ids.has(entry.id)) continue;
    if (!entry.registerBackend) continue;
    await entry.registerBackend();
  }
}

