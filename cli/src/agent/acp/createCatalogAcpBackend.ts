import type { AgentBackend } from '@/agent/core';
import { AGENTS, type CatalogAgentId } from '@/backends/catalog';
import type { CatalogAcpBackendCreateResult, CatalogAcpBackendFactory } from '@/backends/types';

const cachedFactoryPromises = new Map<CatalogAgentId, Promise<CatalogAcpBackendFactory>>();

async function loadCatalogAcpFactory(agentId: CatalogAgentId): Promise<CatalogAcpBackendFactory> {
  const entry = AGENTS[agentId];
  if (!entry.getAcpBackendFactory) {
    throw new Error(`Agent '${agentId}' does not support ACP backends`);
  }
  return await entry.getAcpBackendFactory();
}

async function getCatalogAcpFactory(agentId: CatalogAgentId): Promise<CatalogAcpBackendFactory> {
  const existing = cachedFactoryPromises.get(agentId);
  if (existing) return await existing;

  const promise = loadCatalogAcpFactory(agentId);
  cachedFactoryPromises.set(agentId, promise);
  return await promise;
}

export async function createCatalogAcpBackend<
  TOptions,
  TResult extends CatalogAcpBackendCreateResult = CatalogAcpBackendCreateResult,
>(
  agentId: CatalogAgentId,
  opts: TOptions,
): Promise<TResult> {
  const factory = await getCatalogAcpFactory(agentId);
  return factory(opts as unknown) as TResult;
}
