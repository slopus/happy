import type { AgentCatalogEntry } from '@/backends/catalog';
import { AGENTS } from '@/backends/catalog';

import type { ChecklistId } from './checklistIds';
import type { CapabilityDetectRequest } from './types';

const cliAgentRequests: CapabilityDetectRequest[] = (Object.values(AGENTS) as AgentCatalogEntry[]).map((entry) => ({
    id: `cli.${entry.id}`,
}));

function mergeChecklistContributions(
    base: Record<ChecklistId, CapabilityDetectRequest[]>,
): Record<ChecklistId, CapabilityDetectRequest[]> {
    const next: Record<ChecklistId, CapabilityDetectRequest[]> = { ...base };

    for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
        const contributions = entry.checklists;
        if (!contributions) continue;

        for (const [checklistId, requests] of Object.entries(contributions) as Array<
            [ChecklistId, ReadonlyArray<{ id: string; params?: Record<string, unknown> }>]
        >) {
            const normalized: CapabilityDetectRequest[] = requests.map((r) => ({
                id: r.id as CapabilityDetectRequest['id'],
                ...(r.params ? { params: r.params } : {}),
            }));
            next[checklistId] = [...(next[checklistId] ?? []), ...normalized];
        }
    }

    return next;
}

const baseChecklists: Record<ChecklistId, CapabilityDetectRequest[]> = {
    'new-session': [
        ...cliAgentRequests,
        { id: 'tool.tmux' },
    ],
    'machine-details': [
        ...cliAgentRequests,
        { id: 'tool.tmux' },
        { id: 'dep.codex-mcp-resume' },
        { id: 'dep.codex-acp' },
    ],
    'resume.codex': [],
    'resume.gemini': [],
    'resume.opencode': [],
};

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = mergeChecklistContributions(baseChecklists);
