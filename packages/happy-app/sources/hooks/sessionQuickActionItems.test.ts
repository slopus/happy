import { describe, expect, it, vi } from 'vitest';
import { buildSessionQuickActionItems } from './sessionQuickActionItems';

const labels = {
    pin: 'Pin',
    unpin: 'Unpin',
    details: 'Details',
    resume: 'Resume',
    rename: 'Rename',
    regenerateTitle: 'Regenerate title',
    fork: 'Fork',
    duplicate: 'Duplicate',
    copyMetadata: 'Copy metadata',
    copyMetadataAndLogs: 'Copy metadata & logs',
    archive: 'Archive',
    restore: 'Restore',
    delete: 'Delete',
    select: 'Select',
};

const callbacks = {
    togglePinSession: vi.fn(),
    openDetails: vi.fn(),
    resumeSession: vi.fn(),
    renameSession: vi.fn(),
    regenerateTitle: vi.fn(),
    forkSession: vi.fn(),
    openDuplicateSheet: vi.fn(),
    copySessionMetadata: vi.fn(),
    copySessionMetadataAndLogs: vi.fn(),
    archiveSession: vi.fn(),
    restoreSession: vi.fn(),
    deleteSession: vi.fn(),
};

describe('buildSessionQuickActionItems', () => {
    it('offers pin, rename, archive, and delete for active unpinned sessions', () => {
        const items = buildSessionQuickActionItems({
            labels,
            callbacks: {
                ...callbacks,
                selectSession: vi.fn(),
            },
            canShowResume: false,
            canRegenerateTitle: false,
            canFork: false,
            canCopySessionMetadata: false,
            sessionPinned: false,
            sessionActive: true,
            sessionArchived: false,
            canSelect: true,
        });

        expect(items.map(item => item.id)).toEqual([
            'select',
            'pin',
            'details',
            'rename',
            'archive',
            'delete',
        ]);
    });

    it('offers unpin for pinned sessions', () => {
        const items = buildSessionQuickActionItems({
            labels,
            callbacks,
            canShowResume: false,
            canRegenerateTitle: false,
            canFork: false,
            canCopySessionMetadata: false,
            sessionPinned: true,
            sessionActive: false,
            sessionArchived: true,
            canSelect: false,
        });

        expect(items.map(item => item.id)).toEqual([
            'unpin',
            'details',
            'rename',
            'restore',
            'delete',
        ]);
    });

    it('offers restore but neither archive nor resume for archived sessions', () => {
        const items = buildSessionQuickActionItems({
            labels,
            callbacks: {
                ...callbacks,
                selectSession: vi.fn(),
            },
            canShowResume: true,
            canRegenerateTitle: false,
            canFork: false,
            canCopySessionMetadata: false,
            sessionPinned: false,
            sessionActive: false,
            sessionArchived: true,
            canSelect: false,
        });

        expect(items.map(item => item.id)).toEqual([
            'pin',
            'details',
            'rename',
            'restore',
            'delete',
        ]);
    });

    it('offers title regeneration only when the session reports support', () => {
        const items = buildSessionQuickActionItems({
            labels,
            callbacks,
            canShowResume: false,
            canRegenerateTitle: true,
            canFork: false,
            canCopySessionMetadata: false,
            sessionPinned: false,
            sessionActive: true,
            sessionArchived: false,
        });

        expect(items.map(item => item.id)).toEqual([
            'pin',
            'details',
            'rename',
            'regenerate-title',
            'archive',
            'delete',
        ]);
    });
});
