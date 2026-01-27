import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
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
  checklists,
} satisfies AgentCatalogEntry;

