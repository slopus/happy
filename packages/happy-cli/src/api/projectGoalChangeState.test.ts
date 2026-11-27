import { describe, expect, it } from 'vitest';
import type { GoalProjectCanvasChangeNotice } from '@slopus/happy-wire';
import { projectGoalChangeState } from './projectGoalChangeState';

const canvasId = `canvas-${'a'.repeat(64)}`;
const preview: GoalProjectCanvasChangeNotice = { kind: 'preview', canvasId, baseRevision: 4, revision: 5,
    asset: { id: `asset-${'b'.repeat(64)}`, versionId: 'b'.repeat(64), name: 'Preview.png', mimeType: 'image/png', size: 99, x: 0, y: 0,
        preview: { versionId: 'c'.repeat(64), size: 80 } } };

describe('project change notification scope', () => {
    it('does not refresh legacy project catalogs for a compact preview write', () => {
        const state = projectGoalChangeState({ status: 'running', goalProjectRevision: 'old', startedAt: 7 }, preview, 'preview-token');
        expect(state.goalProjectRevision).toBe('old');
        expect(state.startedAt).toBe(7);
        expect(state.goalProjectCanvasChange).toEqual({ token: 'preview-token', change: preview });
        expect(JSON.stringify(state).length).toBeLessThan(1500);
    });
    it('pairs content invalidation with the same legacy token and clears scope for an unrelated change', () => {
        const content = { kind: 'content' as const, canvasId, baseRevision: 5, revision: 6 };
        const changed = projectGoalChangeState(null, content, 'content-token');
        expect(changed.goalProjectRevision).toBe('content-token');
        expect(changed.goalProjectCanvasChange?.token).toBe('content-token');
        const generic = projectGoalChangeState(changed, undefined, 'generic-token');
        expect(generic.goalProjectRevision).toBe('generic-token');
        expect(generic.goalProjectCanvasChange).toBeUndefined();
    });
});
