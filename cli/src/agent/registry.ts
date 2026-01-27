import type { AgentId } from './core';
import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';

export type AgentRegistrar = () => Promise<void>;

export const agentRegistrarById = Object.fromEntries(
  (Object.values(AGENTS) as AgentCatalogEntry[])
    .filter((entry) => typeof entry.registerBackend === 'function')
    .map((entry) => [entry.id, async () => await entry.registerBackend!()] as const),
) satisfies Partial<Record<AgentId, AgentRegistrar>>;

export async function registerDefaultAgents(): Promise<void> {
  // Register the currently supported registry-backed agents (ACP-style).
  // (claude/codex are not instantiated via AgentRegistry today.)
  await agentRegistrarById.gemini?.();
  await agentRegistrarById.opencode?.();
}
