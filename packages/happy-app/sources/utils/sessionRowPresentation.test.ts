import { describe, expect, it, vi } from 'vitest';
import type { SessionRowData } from '@/sync/storage';
import {
    buildSessionRowPresentation,
    isSessionRowDisclosureVisible,
    isSessionTitleOverflowing,
    reduceSessionRowInteraction,
    shouldShowSessionRowDisclosure,
    shouldUseSessionRowMoreAction,
    stopSessionRowActionPropagation,
} from './sessionRowPresentation';

const labels = {
    remoteLocation: (machine: string) => `Remote · ${machine}`,
    unknownLocation: 'Location unknown/local',
    unknownAgent: 'Unknown agent',
    status: {
        idle: 'Idle',
        running: 'Running',
        permission_required: 'Permission required',
        failed: 'Failed',
        completed: 'Completed',
    },
    relativeTime: (timestamp: number) => `${timestamp}ms`,
};

function session(overrides: Partial<SessionRowData> = {}): SessionRowData {
    return {
        id: 'session-1',
        name: 'Fix the sidebar',
        subtitle: 'happy',
        avatarId: 'avatar',
        flavor: 'codex',
        state: 'idle',
        isConnected: true,
        createdAt: 123,
        hasDraft: false,
        archived: false,
        active: true,
        machineId: 'machine-1',
        path: '/Users/jacky/happy',
        homeDir: '/Users/jacky',
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: false,
        ...overrides,
    };
}

describe('buildSessionRowPresentation', () => {
    it('uses honest remote semantics and exposes every detail field', () => {
        const result = buildSessionRowPresentation(session(), 'Mac mini', labels);

        expect(result).toMatchObject({
            title: 'Fix the sidebar',
            project: '~/happy',
            path: '/Users/jacky/happy',
            machine: 'Mac mini',
            agent: 'Codex',
            relativeTime: '123ms',
            status: 'Idle',
            location: {
                icon: 'desktop-outline',
                kind: 'remote',
                text: 'Remote · Mac mini',
                tooltip: 'Remote · Mac mini',
            },
        });
    });

    it('does not claim an exact local machine when machineId is absent', () => {
        const result = buildSessionRowPresentation(session({ machineId: null }), null, labels);

        expect(result.location).toEqual({
            icon: 'location-outline',
            kind: 'unknown',
            text: 'Location unknown/local',
            tooltip: 'Location unknown/local',
        });
    });
});

describe('session row overflow and disclosure interactions', () => {
    it('only enables the full title hint when the title overflows', () => {
        expect(isSessionTitleOverflowing({ clientWidth: 180, scrollWidth: 180 })).toBe(false);
        expect(isSessionTitleOverflowing({ clientWidth: 180, scrollWidth: 260 })).toBe(true);
        expect(isSessionTitleOverflowing(null)).toBe(false);
    });

    it('opens for hover or keyboard focus and closes on leave, blur, or Escape', () => {
        let state = { focused: false, hovered: false };
        state = reduceSessionRowInteraction(state, 'mouse-enter');
        expect(isSessionRowDisclosureVisible(state)).toBe(true);
        state = reduceSessionRowInteraction(state, 'mouse-leave');
        expect(isSessionRowDisclosureVisible(state)).toBe(false);
        state = reduceSessionRowInteraction(state, 'focus');
        expect(isSessionRowDisclosureVisible(state)).toBe(true);
        state = reduceSessionRowInteraction(state, 'escape');
        expect(isSessionRowDisclosureVisible(state)).toBe(false);
    });

    it('prevents inline actions from triggering row navigation', () => {
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        stopSessionRowActionPropagation({ preventDefault, stopPropagation });
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
    });

    it('uses the viewport and platform for More actions, independent of drawer width', () => {
        expect(shouldUseSessionRowMoreAction('web', 799)).toBe(true);
        expect(shouldUseSessionRowMoreAction('web', 800)).toBe(false);
        expect(shouldUseSessionRowMoreAction('web', 1280, false)).toBe(true);
        expect(shouldUseSessionRowMoreAction('ios', 1280)).toBe(true);
    });

    it('keeps hover details desktop-only so they cannot cover the narrow More menu', () => {
        const hovered = { focused: false, hovered: true };
        expect(shouldShowSessionRowDisclosure('web', 799, hovered)).toBe(false);
        expect(shouldShowSessionRowDisclosure('web', 800, hovered)).toBe(true);
        expect(shouldShowSessionRowDisclosure('ios', 1280, hovered)).toBe(false);
    });
});
