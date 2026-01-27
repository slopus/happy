import { AGENTS_CORE } from '@happy/agents';

import { checklists } from './cli/checklists';
import type { AgentCatalogEntry } from '../types';

export const agent = {
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
  checklists,
} satisfies AgentCatalogEntry;

