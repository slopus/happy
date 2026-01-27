import type { AgentId } from '@/agent/core';
import { checklists as codexChecklists } from '@/codex/cli/checklists';
import { checklists as geminiChecklists } from '@/gemini/cli/checklists';
import { checklists as openCodeChecklists } from '@/opencode/cli/checklists';
import type { AgentCatalogEntry, CatalogAgentId } from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS = {
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
    checklists: codexChecklists,
  },
  gemini: {
    id: 'gemini',
    cliSubcommand: 'gemini',
    getCliCommandHandler: async () => (await import('@/gemini/cli/command')).handleGeminiCliCommand,
    getCliCapabilityOverride: async () => (await import('@/gemini/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/gemini/cli/detect')).cliDetect,
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
    getCliCommandHandler: async () => (await import('@/opencode/cli/command')).handleOpenCodeCliCommand,
    getCliCapabilityOverride: async () => (await import('@/opencode/cli/capability')).cliCapability,
    getCliDetect: async () => (await import('@/opencode/cli/detect')).cliDetect,
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
