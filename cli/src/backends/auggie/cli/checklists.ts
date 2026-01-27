import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.auggie': [{ id: 'cli.auggie', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;

