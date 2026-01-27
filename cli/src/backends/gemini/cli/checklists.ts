import type { AgentChecklistContributions } from '@/backends/types';

export const checklists = {
  'resume.gemini': [{ id: 'cli.gemini', params: { includeAcpCapabilities: true, includeLoginStatus: true } }],
} satisfies AgentChecklistContributions;

