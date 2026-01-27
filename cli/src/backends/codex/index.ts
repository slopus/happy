import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
  id: AGENTS_CORE.codex.id,
  cliSubcommand: AGENTS_CORE.codex.cliSubcommand,
  getCliCommandHandler: async () => (await import('@/backends/codex/cli/command')).handleCodexCliCommand,
  getCliCapabilityOverride: async () => (await import('@/backends/codex/cli/capability')).cliCapability,
  getCapabilities: async () => (await import('@/backends/codex/cli/extraCapabilities')).capabilities,
  getCliDetect: async () => (await import('@/backends/codex/cli/detect')).cliDetect,
  getCloudConnectTarget: async () => (await import('@/backends/codex/cloud/connect')).codexCloudConnect,
  getDaemonSpawnHooks: async () => (await import('@/backends/codex/daemon/spawnHooks')).codexDaemonSpawnHooks,
  vendorResumeSupport: AGENTS_CORE.codex.resume.vendorResume,
  getVendorResumeSupport: async () => (await import('@/backends/codex/resume/vendorResumeSupport')).supportsCodexVendorResume,
  getAcpBackendFactory: async () => {
    const { createCodexAcpBackend } = await import('@/backends/codex/acp/backend');
    return (opts) => createCodexAcpBackend(opts as any);
  },
  checklists,
} satisfies AgentCatalogEntry;

