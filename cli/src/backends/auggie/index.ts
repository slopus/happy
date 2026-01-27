import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.auggie.id,
  cliSubcommand: AGENTS_CORE.auggie.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/auggie/cli/command')).handleAuggieCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/auggie/cli/capability')).cliCapability,
  getCliDetect: async () => (await import('@/backends/auggie/cli/detect')).cliDetect,
  vendorResumeSupport: AGENTS_CORE.auggie.resume.vendorResume,
  getAcpBackendFactory: async () => {
    const { createAuggieBackend } = await import('@/backends/auggie/acp/backend');
    return (opts) => ({ backend: createAuggieBackend(opts as any) });
  },
  checklists,
} satisfies AgentCatalogEntry;

