import type { AgentCatalogEntry } from '@/backends/catalog';
import { AGENTS } from '@/backends/catalog';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { AGENTS_CORE } from '@happy/agents';

import { CHECKLIST_IDS, resumeChecklistId, type ChecklistId } from './checklistIds';
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

const resumeChecklistEntries = Object.fromEntries(
    CATALOG_AGENT_IDS.map((id) => {
        const runtimeGate = AGENTS_CORE[id].resume.runtimeGate;
        const requests: CapabilityDetectRequest[] = [];
        if (runtimeGate === 'acpLoadSession') {
            requests.push({
                id: `cli.${id}`,
                params: { includeAcpCapabilities: true, includeLoginStatus: true },
            });
        }
        return [resumeChecklistId(id), requests] as const;
    }),
) as Record<`resume.${CatalogAgentId}`, CapabilityDetectRequest[]>;

const baseChecklists = {
    [CHECKLIST_IDS.NEW_SESSION]: [
        ...cliAgentRequests,
        { id: 'tool.tmux' },
    ],
    [CHECKLIST_IDS.MACHINE_DETAILS]: [
        ...cliAgentRequests,
        { id: 'tool.tmux' },
        { id: 'dep.codex-mcp-resume' },
        { id: 'dep.codex-acp' },
    ],
    ...resumeChecklistEntries,
} satisfies Record<ChecklistId, CapabilityDetectRequest[]>;

export const checklists: Record<ChecklistId, CapabilityDetectRequest[]> = mergeChecklistContributions(baseChecklists);
