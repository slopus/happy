import { describe, expect, it, vi } from 'vitest';

vi.mock('./storage', () => ({
    storage: {
        getState: () => ({ sessions: {} }),
    },
}));

import { getAllCommands } from './suggestionCommands';

describe('suggestionCommands', () => {
    it('includes /goal in the default slash command suggestions', () => {
        const commands = getAllCommands('missing-session');

        expect(commands).toEqual(expect.arrayContaining([
            expect.objectContaining({
                command: 'goal',
                description: 'Set a session goal',
            }),
        ]));
    });
});
