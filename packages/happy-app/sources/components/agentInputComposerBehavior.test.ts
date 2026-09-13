import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
}));

import {
    resolveComposerReturnKeyType,
    resolveComposerSubmitBehavior,
} from './agentInputComposerBehavior';

describe('agent input composer behavior', () => {
    it.each([
        [true, 'ios', 'submit'],
        [true, 'android', 'submit'],
        [true, 'web', 'newline'],
        [false, 'ios', 'newline'],
    ] as const)(
        'resolves submit behavior for enter-to-send=%s on %s',
        (agentInputEnterToSend, platformOS, expected) => {
            expect(resolveComposerSubmitBehavior(agentInputEnterToSend, platformOS)).toBe(expected);
        },
    );

    it.each([
        [true, 'ios', 'send'],
        [true, 'web', 'default'],
        [false, 'ios', 'default'],
    ] as const)(
        'resolves return key type for enter-to-send=%s on %s',
        (agentInputEnterToSend, platformOS, expected) => {
            expect(resolveComposerReturnKeyType(agentInputEnterToSend, platformOS)).toBe(expected);
        },
    );
});
