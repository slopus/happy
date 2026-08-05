import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used for this hook harness.
import TestRenderer from 'react-test-renderer';
import type { Command } from './types';
import { useCommandPalette } from './useCommandPalette';

let palette: ReturnType<typeof useCommandPalette>;

function Harness({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
    palette = useCommandPalette(commands, onClose);
    return null;
}

describe('useCommandPalette', () => {
    const onClose = vi.fn();
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    let renderer: any;
    const commands: Command[] = [
        {
            id: 'new-session',
            title: 'New session',
            category: 'Commands',
            action: actions[0],
        },
        {
            id: 'session-alpha',
            title: 'Release plan',
            subtitle: '~/projects/alpha',
            metadata: [
                { icon: 'desktop-outline', text: 'Mac mini' },
                { icon: 'sparkles-outline', text: 'Release Agent' },
            ],
            keywords: ['/Users/jacky/projects/alpha', 'codex'],
            category: 'Sessions',
            showWhenEmpty: false,
            action: actions[1],
        },
        {
            id: 'settings',
            title: 'Settings',
            category: 'Commands',
            action: actions[2],
        },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        act(() => {
            renderer = TestRenderer.create(<Harness commands={commands} onClose={onClose} />);
        });
    });

    afterEach(() => {
        act(() => renderer.unmount());
        vi.unstubAllGlobals();
    });

    it('keeps commands at empty query and searches session machine, agent, project, and flavor metadata', () => {
        expect(palette.filteredCategories.flatMap((category) => category.commands).map((command) => command.id))
            .toEqual(['new-session', 'settings']);

        for (const query of ['mini', 'release agent', 'alpha', 'codex']) {
            act(() => palette.handleSearchChange(query));
            expect(palette.filteredCategories.flatMap((category) => category.commands).map((command) => command.id))
                .toEqual(['session-alpha']);
        }
    });

    it('supports arrows, Enter, Escape, and Alt/Option+1..9 without consuming bare digits', () => {
        act(() => palette.handleKeyPress('ArrowDown'));
        expect(palette.selectedIndex).toBe(1);

        act(() => palette.handleKeyPress('Enter'));
        expect(actions[2]).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();

        act(() => palette.handleKeyPress('1'));
        expect(actions[0]).not.toHaveBeenCalled();

        act(() => palette.handleKeyPress('Alt+1'));
        expect(actions[0]).toHaveBeenCalledOnce();

        act(() => palette.handleKeyPress('Escape'));
        expect(onClose).toHaveBeenCalledTimes(3);
    });
});
