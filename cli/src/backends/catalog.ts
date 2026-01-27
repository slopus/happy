import type { AgentId } from '@/agent/core';
import { checklists as codexChecklists } from '@/codex/cli/checklists';
import { checklists as geminiChecklists } from '@/gemini/cli/checklists';
import { checklists as openCodeChecklists } from '@/opencode/cli/checklists';
import { DEFAULT_CATALOG_AGENT_ID } from './types';
import type { AgentCatalogEntry, CatalogAgentId, VendorResumeSupportFn } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = {
  claude: {
    id: 'claude',
    cliSubcommand: 'claude',
    getCliCommandHandler: async () => (await import('@/claude/cli/command')).handleClaudeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/claude/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/claude/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/claude/cloud/connect')).claudeCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/claude/daemon/spawnHooks')).claudeDaemonSpawnHooks,
    vendorResumeSupport: 'supported',
    getHeadlessTmuxArgvTransform: async () => (await import('@/claude/terminal/headlessTmuxTransform')).claudeHeadlessTmuxArgvTransform,
  },
  codex: {
    id: 'codex',
    cliSubcommand: 'codex',
    getCliCommandHandler: async () => (await import('@/codex/cli/command')).handleCodexCliCommand,
    getCliCapabilityOverride: async () => (await import('@/codex/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/codex/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/codex/cloud/connect')).codexCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/codex/daemon/spawnHooks')).codexDaemonSpawnHooks,
    vendorResumeSupport: 'experimental',
    getVendorResumeSupport: async () => (await import('@/codex/resume/vendorResumeSupport')).supportsCodexVendorResume,
    getAcpBackendFactory: async () => {
      const { createCodexAcpBackend } = await import('@/codex/acp/backend');
      return (opts) => createCodexAcpBackend(opts as any);
    },
    checklists: codexChecklists,
  },
  gemini: {
    id: 'gemini',
    cliSubcommand: 'gemini',
    getCliCommandHandler: async () => (await import('@/gemini/cli/command')).handleGeminiCliCommand,
    getCliCapabilityOverride: async () => (await import('@/gemini/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/gemini/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/gemini/cloud/connect')).geminiCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/gemini/daemon/spawnHooks')).geminiDaemonSpawnHooks,
    vendorResumeSupport: 'supported',
    getAcpBackendFactory: async () => {
      const { createGeminiBackend } = await import('@/gemini/acp/backend');
      return (opts) => createGeminiBackend(opts as any);
    },
    checklists: geminiChecklists,
  },
  opencode: {
    id: 'opencode',
    cliSubcommand: 'opencode',
    getCliCommandHandler: async () => (await import('@/opencode/cli/command')).handleOpenCodeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/opencode/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/opencode/cli/detect')).cliDetect,
    getDaemonSpawnHooks: async () => (await import('@/opencode/daemon/spawnHooks')).opencodeDaemonSpawnHooks,
    vendorResumeSupport: 'supported',
    getAcpBackendFactory: async () => {
      const { createOpenCodeBackend } = await import('@/opencode/acp/backend');
      return (opts) => ({ backend: createOpenCodeBackend(opts as any) });
    },
    checklists: openCodeChecklists,
  },
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
