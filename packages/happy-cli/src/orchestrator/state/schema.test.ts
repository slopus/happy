import { describe, it, expect } from 'vitest';
import {
    AxStateSchema,
    AxStepSchema,
    PermissionValueSchema,
    CandidatesSourceSchema,
    createInitialState,
} from './schema';

describe('AxStepSchema', () => {
    it('accepts plan, design, work', () => {
        expect(AxStepSchema.parse('plan')).toBe('plan');
        expect(AxStepSchema.parse('design')).toBe('design');
        expect(AxStepSchema.parse('work')).toBe('work');
    });

    it('rejects unknown step', () => {
        expect(() => AxStepSchema.parse('coding')).toThrow();
    });
});

describe('PermissionValueSchema', () => {
    it('accepts ask/always/never', () => {
        expect(PermissionValueSchema.parse('ask')).toBe('ask');
        expect(PermissionValueSchema.parse('always')).toBe('always');
        expect(PermissionValueSchema.parse('never')).toBe('never');
    });

    it('rejects other values', () => {
        expect(() => PermissionValueSchema.parse('maybe')).toThrow();
    });
});

describe('CandidatesSourceSchema', () => {
    it('accepts claude-suggested and user-picked', () => {
        expect(CandidatesSourceSchema.parse('claude-suggested')).toBe('claude-suggested');
        expect(CandidatesSourceSchema.parse('user-picked')).toBe('user-picked');
    });
});

describe('createInitialState', () => {
    it('creates plan-step initial state with a history entry', () => {
        const state = createInitialState('plan');
        expect(state.version).toBe(1);
        expect(state.step).toBe('plan');
        expect(state.plan.filePath).toBe('AX_PROJECT_PLAN.md');
        expect(state.plan.completedAt).toBeNull();
        expect(state.design.candidates).toEqual([]);
        expect(state.design.candidatesSource).toBe('claude-suggested');
        expect(state.design.selected).toBeNull();
        expect(state.design.filePath).toBe('AX_STUDIO_DESIGN.md');
        expect(state.design.completedAt).toBeNull();
        expect(state.work.startedAt).toBeNull();
        expect(state.work.permissions.editPlanMd).toBe('ask');
        expect(state.work.permissions.editDesignMd).toBe('ask');
        expect(state.history).toHaveLength(1);
        expect(state.history[0]).toMatchObject({ from: null, to: 'plan' });
        expect(typeof state.history[0].at).toBe('string');
        // Resulting object satisfies the full schema
        expect(() => AxStateSchema.parse(state)).not.toThrow();
    });

    it('creates work-step initial state for git/zip entry', () => {
        const state = createInitialState('work');
        expect(state.step).toBe('work');
        expect(state.history[0]).toMatchObject({ from: null, to: 'work' });
        expect(() => AxStateSchema.parse(state)).not.toThrow();
    });
});

describe('AxStateSchema', () => {
    it('accepts a fully-formed valid state', () => {
        const valid = {
            version: 1,
            step: 'design',
            plan: { filePath: 'AX_PROJECT_PLAN.md', completedAt: '2026-05-19T10:00:00.000Z' },
            design: {
                candidates: ['bmw-m', 'linear', 'stripe'],
                candidatesSource: 'claude-suggested',
                selected: 'bmw-m',
                filePath: 'AX_STUDIO_DESIGN.md',
                completedAt: null,
            },
            work: {
                startedAt: null,
                permissions: { editPlanMd: 'always', editDesignMd: 'ask' },
            },
            history: [
                { from: null, to: 'plan', at: '2026-05-19T09:00:00.000Z' },
                { from: 'plan', to: 'design', at: '2026-05-19T10:00:00.000Z' },
            ],
        };
        expect(() => AxStateSchema.parse(valid)).not.toThrow();
    });

    it('rejects state with wrong version', () => {
        const state = createInitialState('plan');
        expect(() => AxStateSchema.parse({ ...state, version: 2 })).toThrow();
    });

    it('rejects state with invalid step', () => {
        const state = createInitialState('plan');
        expect(() => AxStateSchema.parse({ ...state, step: 'review' })).toThrow();
    });

    it('rejects state with too many design candidates', () => {
        const state = createInitialState('plan');
        const bad = {
            ...state,
            design: {
                ...state.design,
                candidates: Array.from({ length: 11 }, (_, i) => `slug-${i}`),
            },
        };
        expect(() => AxStateSchema.parse(bad)).toThrow();
    });

    it('rejects state missing permissions', () => {
        const state = createInitialState('plan');
        const bad = {
            ...state,
            work: { startedAt: null, permissions: { editPlanMd: 'ask' } },
        };
        expect(() => AxStateSchema.parse(bad)).toThrow();
    });
});
