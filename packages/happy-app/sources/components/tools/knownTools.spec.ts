import { describe, expect, it, vi } from 'vitest';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
    Octicons: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

import { knownTools } from './knownTools';

describe('knownTools', () => {
    it('hides Claude Skill tool calls from chat rendering', () => {
        expect((knownTools as Record<string, { hidden?: boolean }>).Skill?.hidden).toBe(true);
    });

    it('renders Happy Agent SDK tools as one-line rows instead of raw JSON cards', () => {
        const registry = knownTools as Record<string, { minimal?: unknown }>;
        for (const name of ['TaskCreate', 'TaskUpdate', 'create_agent', 'web_fetch', 'web_search', 'create_workspace']) {
            expect(registry[name]?.minimal, name).toBe(true);
        }
    });
});
