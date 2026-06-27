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
});
