import type { NewSessionAgentType } from '@/sync/persistence';
import { HARNESS_ORDER, isRetiredHarness, type HarnessAvailability } from '@/utils/harnessCatalog';

export const NEW_SESSION_AGENT_ORDER = HARNESS_ORDER;

type CliAvailability = HarnessAvailability;

/** The harness a retired draft falls back to when nothing else is reported. */
const DEFAULT_AGENT: NewSessionAgentType = 'claude';

/**
 * Keep the persisted selection when it is still installed. If it is stale,
 * use the first CLI the selected machine actually reports as available.
 * Older machines without capability metadata retain the persisted selection.
 *
 * A retired harness is always replaced, installed or not: its CLI being
 * present on the machine is exactly the case where a stale draft would
 * otherwise keep starting sessions on an agent we no longer offer.
 */
export function resolveMachineAgent(
    selectedAgent: NewSessionAgentType,
    availability: CliAvailability | null | undefined,
): NewSessionAgentType {
    if (isRetiredHarness(selectedAgent)) {
        return NEW_SESSION_AGENT_ORDER.find((agent) => !availability || availability[agent])
            ?? DEFAULT_AGENT;
    }

    if (!availability || availability[selectedAgent]) {
        return selectedAgent;
    }

    return NEW_SESSION_AGENT_ORDER.find((agent) => availability[agent]) ?? selectedAgent;
}
