import type { AgentId } from '@happy/agents';

export const CHECKLIST_IDS = {
  NEW_SESSION: 'new-session',
  MACHINE_DETAILS: 'machine-details',
} as const;

export type ChecklistId = (typeof CHECKLIST_IDS)[keyof typeof CHECKLIST_IDS] | `resume.${AgentId}`;

export function resumeChecklistId(agentId: AgentId): `resume.${AgentId}` {
  return `resume.${agentId}`;
}
