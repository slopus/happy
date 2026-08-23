import { describe, expect, it } from 'vitest';

import {
    getPermissionModeMenuLabel,
    getPermissionModeShortLabel,
    sortPermissionModes,
} from './permissionModeLabels';

describe('permission mode labels', () => {
    it('shortens a harness-published name to its first word', () => {
        expect(getPermissionModeShortLabel({ name: 'Workspace write' })).toBe('Workspace');
        expect(getPermissionModeShortLabel({ name: 'Read only' })).toBe('Read');
        expect(getPermissionModeShortLabel({ name: 'Full access' })).toBe('Full');
        expect(getPermissionModeShortLabel({ name: 'Auto' })).toBe('Auto');
    });

    it('has no label without a mode', () => {
        expect(getPermissionModeShortLabel(null)).toBeNull();
        expect(getPermissionModeShortLabel({ name: '   ' })).toBeNull();
    });

    it('describes a one-word mode, since the word alone says nothing', () => {
        // Auto and Default both shorten to one word on the chip, and the words
        // alone do not say which is which, hence the description on the row.
        expect(getPermissionModeMenuLabel({
            name: 'Auto',
            description: 'reviews its own calls',
        })).toBe('Auto · reviews its own calls');
        expect(getPermissionModeMenuLabel({ name: 'Yolo' })).toBe('Yolo');
    });

    // A harness that names its modes in full already says what they do, and
    // appending a sentence wrapped the row and truncated it mid-word.
    it('leaves a multi-word published name to speak for itself', () => {
        expect(getPermissionModeMenuLabel({
            name: 'Workspace write',
            description: 'Allows workspace changes without asking',
        })).toBe('Workspace write');
        expect(getPermissionModeMenuLabel({
            name: 'Read only',
            description: null,
        })).toBe('Read only');
    });

    it('orders a published catalog by pick priority', () => {
        const modes = sortPermissionModes([
            { key: 'full_access', name: 'Full access' },
            { key: 'read_only', name: 'Read only' },
            { key: 'workspace_write', name: 'Workspace write' },
            { key: 'ask', name: 'Default' },
            { key: 'auto', name: 'Auto' },
        ]);

        expect(modes.map((mode) => mode.key)).toEqual([
            'auto',
            'workspace_write',
            'read_only',
            'full_access',
            'ask',
        ]);
    });

    it('sorts Edits with Auto and leaves Default last', () => {
        const modes = sortPermissionModes([
            { key: 'default', name: 'Default' },
            { key: 'bypassPermissions', name: 'Yolo' },
            { key: 'plan', name: 'Plan' },
            { key: 'acceptEdits', name: 'Edits' },
        ]);

        expect(modes.map((mode) => mode.key)).toEqual([
            'acceptEdits',
            'plan',
            'bypassPermissions',
            'default',
        ]);
    });

    it('keeps words it does not know above Default, in published order', () => {
        const modes = sortPermissionModes([
            { key: 'ask', name: 'Default' },
            { key: 'bespoke', name: 'Bespoke mode' },
            { key: 'other', name: 'Other' },
            { key: 'auto', name: 'Auto' },
        ]);

        expect(modes.map((mode) => mode.key)).toEqual(['auto', 'bespoke', 'other', 'ask']);
    });
});
