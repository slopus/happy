import { describe, it, expect } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happy/agents';

import { AGENT_IDS, DEFAULT_AGENT_ID, getAgentCore } from './catalog';

describe('agents/catalog', () => {
    it('re-exports the canonical shared agent id list', () => {
        // Reference equality ensures we’re not accidentally redefining the list in Expo.
        expect(AGENT_IDS).toBe(SHARED_AGENT_IDS);
        expect(DEFAULT_AGENT_ID).toBe('claude');
    });

    it('composes core + ui + behavior for known agents', () => {
        for (const id of AGENT_IDS) {
            const core = getAgentCore(id);
            expect(core.id).toBe(id);
        }
    });
});
