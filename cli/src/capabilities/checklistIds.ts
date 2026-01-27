import type { CatalogAgentId } from '@/backends/types';

export type ChecklistId = 'new-session' | 'machine-details' | `resume.${CatalogAgentId}`;
