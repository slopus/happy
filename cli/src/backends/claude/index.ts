import { AGENTS_CORE } from '@happy/agents';

import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.claude.id,
  cliSubcommand: AGENTS_CORE.claude.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/claude/cli/command')).handleClaudeCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/claude/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/claude/cli/detect')).cliDetect,
  getCloudConnectTarget: async () => (await import('@/backends/claude/cloud/connect')).claudeCloudConnect,
  getDaemonSpawnHooks: async () => (await import('@/backends/claude/daemon/spawnHooks')).claudeDaemonSpawnHooks,
  vendorResumeSupport: AGENTS_CORE.claude.resume.vendorResume,
  getHeadlessTmuxArgvTransform: async () =>
    (await import('@/backends/claude/terminal/headlessTmuxTransform')).claudeHeadlessTmuxArgvTransform,
} satisfies AgentCatalogEntry;

