import type { AgentId } from '@/agent/core';
import { checklists as codexChecklists } from '@/backends/codex/cli/checklists';
import { checklists as geminiChecklists } from '@/backends/gemini/cli/checklists';
import { checklists as openCodeChecklists } from '@/backends/opencode/cli/checklists';
import { AGENTS_CORE } from '@happy/agents';
import { DEFAULT_CATALOG_AGENT_ID } from './types';
import type { AgentCatalogEntry, CatalogAgentId, VendorResumeSupportFn } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = {
  claude: {
    id: AGENTS_CORE.claude.id,
    cliSubcommand: AGENTS_CORE.claude.cliSubcommand,
    getCliCommandHandler: async () => (await import('@/backends/claude/cli/command')).handleClaudeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/backends/claude/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/backends/claude/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/backends/claude/cloud/connect')).claudeCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/backends/claude/daemon/spawnHooks')).claudeDaemonSpawnHooks,
    vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
    getHeadlessTmuxArgvTransform: async () => (await import('@/backends/claude/terminal/headlessTmuxTransform')).claudeHeadlessTmuxArgvTransform,
  },
  codex: {
    id: AGENTS_CORE.codex.id,
    cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
    getCliCommandHandler: async () => (await import('@/backends/codex/cli/command')).handleCodexCliCommand,
    getCliCapabilityOverride: async () => (await import('@/backends/codex/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/backends/codex/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/backends/codex/cloud/connect')).codexCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/backends/codex/daemon/spawnHooks')).codexDaemonSpawnHooks,
    vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
    getVendorResumeSupport: async () => (await import('@/backends/codex/resume/vendorResumeSupport')).supportsCodexVendorResume,
    getAcpBackendFactory: async () => {
      const { createCodexAcpBackend } = await import('@/backends/codex/acp/backend');
      return (opts) => createCodexAcpBackend(opts as any);
    },
    checklists: codexChecklists,
  },
  gemini: {
    id: AGENTS_CORE.gemini.id,
    cliSubcommand: AGENTS_CORE.gemini.cliSubcommand,
    getCliCommandHandler: async () => (await import('@/backends/gemini/cli/command')).handleGeminiCliCommand,
    getCliCapabilityOverride: async () => (await import('@/backends/gemini/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/backends/gemini/cli/detect')).cliDetect,
    getCloudConnectTarget: async () => (await import('@/backends/gemini/cloud/connect')).geminiCloudConnect,
    getDaemonSpawnHooks: async () => (await import('@/backends/gemini/daemon/spawnHooks')).geminiDaemonSpawnHooks,
    vendorResumeSupport: AGENTS_CORE.gemini.resume.vendorResume,
    getAcpBackendFactory: async () => {
      const { createGeminiBackend } = await import('@/backends/gemini/acp/backend');
      return (opts) => createGeminiBackend(opts as any);
    },
    checklists: geminiChecklists,
  },
  opencode: {
    id: AGENTS_CORE.opencode.id,
    cliSubcommand: AGENTS_CORE.opencode.cliSubcommand,
    getCliCommandHandler: async () => (await import('@/backends/opencode/cli/command')).handleOpenCodeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/backends/opencode/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/backends/opencode/cli/detect')).cliDetect,
    getDaemonSpawnHooks: async () => (await import('@/backends/opencode/daemon/spawnHooks')).opencodeDaemonSpawnHooks,
    vendorResumeSupport: AGENTS_CORE.opencode.resume.vendorResume,
    getAcpBackendFactory: async () => {
      const { createOpenCodeBackend } = await import('@/backends/opencode/acp/backend');
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
