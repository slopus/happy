import type { AgentId } from '@/agent/core';
import { agent as auggie } from '@/backends/auggie';
import { agent as claude } from '@/backends/claude';
import { agent as codex } from '@/backends/codex';
import { agent as gemini } from '@/backends/gemini';
import { agent as opencode } from '@/backends/opencode';
import { DEFAULT_CATALOG_AGENT_ID } from './types';
import type { AgentCatalogEntry, CatalogAgentId, VendorResumeSupportFn } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = {
  claude,
  codex,
  gemini,
  opencode,
  auggie,
};

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();

export async function getVendorResumeSupport(agentId?: AgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedVendorResumeSupportPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = (async () => {
    if (entry.vendorResumeSupport === 'supported') {
      return () => true;
    }
    if (entry.vendorResumeSupport === 'unsupported') {
      return () => false;
    }
    if (entry.getVendorResumeSupport) {
      return await entry.getVendorResumeSupport();
    }
    return () => false;
  })();

  cachedVendorResumeSupportPromises.set(catalogId, promise);
  return await promise;
}

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? DEFAULT_CATALOG_AGENT_ID;
  const base = raw.split('-')[0] as CatalogAgentId;
  if (Object.prototype.hasOwnProperty.call(AGENTS, base)) {
    return base;
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentId {
  const catalogId = resolveCatalogAgentId(agentId);
  return AGENTS[catalogId].cliSubcommand;
}
