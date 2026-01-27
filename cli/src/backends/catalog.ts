import { CODEX_MCP_RESUME_DIST_TAG } from '@/capabilities/deps/codexMcpResume';
import type { AgentId } from '@/agent/core';
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
    checklists: {
      'resume.codex': [
        // Codex can be resumed via either:
        // - MCP resume (codex-mcp-resume), or
        // - ACP resume (codex-acp + ACP `loadSession` support)
        //
        // The app uses this checklist for inactive-session resume UX, so include both:
        // - `includeAcpCapabilities` so the UI can enable/disable resume correctly when `expCodexAcp` is enabled
        // - dep statuses so we can block with a helpful install prompt
        { id: 'cli.codex', params: { includeAcpCapabilities: true, includeLoginStatus: true } },
        { id: 'dep.codex-acp', params: { onlyIfInstalled: true, includeRegistry: true } },
        {
          id: 'dep.codex-mcp-resume',
          params: { includeRegistry: true, onlyIfInstalled: true, distTag: CODEX_MCP_RESUME_DIST_TAG },
        },
      ],
    },
  },
  gemini: {
    id: 'gemini',
    cliSubcommand: 'gemini',
    getCliCommandHandler: async () => (await import('@/cli/commands/gemini')).handleGeminiCliCommand,
    getCliCapabilityOverride: async () => (await import('@/gemini/cliCapability')).cliCapability,
    getCliDetect: async () => (await import('@/gemini/detect')).cliDetect,
    checklists: {
      'resume.gemini': [{ id: 'cli.gemini', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
    },
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
    checklists: {
      'resume.opencode': [{ id: 'cli.opencode', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
    },
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
