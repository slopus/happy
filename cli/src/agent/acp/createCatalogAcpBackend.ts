import type { AgentBackend } from '@/agent/core';
import { AGENTS, type CatalogAgentId } from '@/backends/catalog';
import type { CatalogAcpBackendFactory } from '@/backends/types';
import type { CodexAcpBackendOptions, CodexAcpBackendResult } from '@/codex/acp/backend';
import type { GeminiBackendOptions, GeminiBackendResult } from '@/gemini/acp/backend';
import type { OpenCodeBackendOptions } from '@/opencode/acp/backend';

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

export type CatalogAcpAgentId = Extract<CatalogAgentId, 'codex' | 'gemini' | 'opencode'>;

export type CatalogAcpBackendOptionsByAgent = Readonly<{
  gemini: GeminiBackendOptions;
  codex: CodexAcpBackendOptions;
  opencode: OpenCodeBackendOptions;
}>;

export type CatalogAcpBackendResultByAgent = Readonly<{
  gemini: GeminiBackendResult;
  codex: CodexAcpBackendResult;
  opencode: Readonly<{ backend: AgentBackend }>;
}>;

export async function createCatalogAcpBackend<TAgentId extends CatalogAcpAgentId>(
  agentId: TAgentId,
  opts: CatalogAcpBackendOptionsByAgent[TAgentId],
): Promise<CatalogAcpBackendResultByAgent[TAgentId]> {
  const factory = await getCatalogAcpFactory(agentId);
  return factory(opts) as CatalogAcpBackendResultByAgent[TAgentId];
}
