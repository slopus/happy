import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.opencode': [{ id: 'cli.opencode', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;

