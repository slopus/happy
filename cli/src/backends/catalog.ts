import type { AgentId } from '@/agent/core';
import { checklists as codexChecklists } from '@/codex/checklists';
import { checklists as geminiChecklists } from '@/gemini/checklists';
import { checklists as openCodeChecklists } from '@/opencode/checklists';
import type { AgentCatalogEntry, CatalogAgentId } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS = {
  claude: {
    id: 'claude',
    cliSubcommand: 'claude',
    getCliCapabilityOverride: async () => (await import('@/claude/cliCapability')).cliCapability,
    getCliDetect: async () => (await import('@/claude/detect')).cliDetect,
  },
  codex: {
    id: 'codex',
    cliSubcommand: 'codex',
    getCliCommandHandler: async () => (await import('@/cli/commands/codex')).handleCodexCliCommand,
    getCliCapabilityOverride: async () => (await import('@/codex/cliCapability')).cliCapability,
    getCliDetect: async () => (await import('@/codex/detect')).cliDetect,
    checklists: codexChecklists,
  },
  gemini: {
    id: 'gemini',
    cliSubcommand: 'gemini',
    getCliCommandHandler: async () => (await import('@/cli/commands/gemini')).handleGeminiCliCommand,
    getCliCapabilityOverride: async () => (await import('@/gemini/cliCapability')).cliCapability,
    getCliDetect: async () => (await import('@/gemini/detect')).cliDetect,
    checklists: geminiChecklists,
    registerBackend: () => {
      return import('@/gemini/acp/backend').then(({ registerGeminiAgent }) => {
        registerGeminiAgent();
      });
    },
  },
  opencode: {
    id: 'opencode',
    cliSubcommand: 'opencode',
    getCliCommandHandler: async () => (await import('@/cli/commands/opencode')).handleOpenCodeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/opencode/cliCapability')).cliCapability,
    getCliDetect: async () => (await import('@/opencode/detect')).cliDetect,
    checklists: openCodeChecklists,
    registerBackend: () => {
      return import('@/opencode/acp/backend').then(({ registerOpenCodeAgent }) => {
        registerOpenCodeAgent();
      });
    },
  },
} satisfies Record<CatalogAgentId, AgentCatalogEntry>;

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
