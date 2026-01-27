import type { AgentId } from '@/agent/core';
import { checklists as codexChecklists } from '@/codex/cli/checklists';
import { checklists as geminiChecklists } from '@/gemini/cli/checklists';
import { checklists as openCodeChecklists } from '@/opencode/cli/checklists';
import type { AgentCatalogEntry, CatalogAgentId } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = {
  claude: {
    id: 'claude',
    cliSubcommand: 'claude',
    getCliCommandHandler: async () => (await import('@/claude/cli/command')).handleClaudeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/claude/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/claude/cli/detect')).cliDetect,
  },
  codex: {
    id: 'codex',
    cliSubcommand: 'codex',
    getCliCommandHandler: async () => (await import('@/codex/cli/command')).handleCodexCliCommand,
    getCliCapabilityOverride: async () => (await import('@/codex/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/codex/cli/detect')).cliDetect,
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
    getAcpBackendFactory: async () => {
      const { createOpenCodeBackend } = await import('@/opencode/acp/backend');
      return (opts) => ({ backend: createOpenCodeBackend(opts as any) });
    },
    checklists: openCodeChecklists,
  },
};

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? 'claude';
  const base = raw.split('-')[0] as CatalogAgentId;
  if (Object.prototype.hasOwnProperty.call(AGENTS, base)) {
    return base;
  }
  return 'claude';
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentId {
  const catalogId = resolveCatalogAgentId(agentId);
  return AGENTS[catalogId].cliSubcommand;
}
