import { describe, it, expect } from 'vitest';
import { decidePreToolUse, PreToolUseInput } from './preToolUse';
import { AxState, createInitialState } from '../orchestrator/state/schema';

function inWorkspace(state: AxState, toolName: string, toolInput: Record<string, unknown>): PreToolUseInput {
    return {
        cwd: '/tmp/ws',
        toolName,
        toolInput,
        state,
    };
}

describe('decidePreToolUse — step: plan', () => {
    const state = createInitialState('plan');

    it('allows writes to AX_PROJECT_PLAN.md', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md', content: '# Plan' }),
        );
        expect(result.decision).toBe('allow');
    });

    it('allows writes to .ax/state.json with a valid payload', () => {
        const valid = JSON.stringify({ ...state, plan: { ...state.plan, completedAt: '2026-05-19T10:00:00.000Z' } });
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/.ax/state.json', content: valid }),
        );
        expect(result.decision).toBe('allow');
    });

    it('denies writes to a code file', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/src/app.tsx', content: 'export default ...' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toMatch(/plan/i);
    });

    it('denies writes to AX_STUDIO_DESIGN.md (wrong step)', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/AX_STUDIO_DESIGN.md', content: '...' }),
        );
        expect(result.decision).toBe('deny');
    });

    it('denies writes to .ax/state.json with an invalid payload (schema violation)', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/.ax/state.json', content: '{"version":1,"step":"bogus"}' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toMatch(/schema|invalid|state\.json/i);
    });

    it('denies writes to .ax/state.json with invalid JSON', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/.ax/state.json', content: '{not json' }),
        );
        expect(result.decision).toBe('deny');
    });
});

describe('decidePreToolUse — step: design', () => {
    const state = createInitialState('design');

    it('allows writes to AX_STUDIO_DESIGN.md', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/AX_STUDIO_DESIGN.md', content: '# Design' }),
        );
        expect(result.decision).toBe('allow');
    });

    it('denies writes to AX_PROJECT_PLAN.md (locked in design step)', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md', content: '...' }),
        );
        expect(result.decision).toBe('deny');
    });

    it('denies writes to code files', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'Write', { file_path: '/tmp/ws/src/index.ts', content: '...' }),
        );
        expect(result.decision).toBe('deny');
    });
});

describe('decidePreToolUse — step: work', () => {
    const stateAsk = createInitialState('work');
    const stateAlways: AxState = {
        ...stateAsk,
        work: { ...stateAsk.work, permissions: { editPlanMd: 'always', editDesignMd: 'always' } },
    };
    const stateNever: AxState = {
        ...stateAsk,
        work: { ...stateAsk.work, permissions: { editPlanMd: 'never', editDesignMd: 'never' } },
    };

    it('allows arbitrary code writes', () => {
        const result = decidePreToolUse(
            inWorkspace(stateAsk, 'Write', { file_path: '/tmp/ws/src/index.ts', content: '...' }),
        );
        expect(result.decision).toBe('allow');
    });

    it('denies AX_PROJECT_PLAN.md edits when permission=ask, pointing user to the panel', () => {
        const result = decidePreToolUse(
            inWorkspace(stateAsk, 'Edit', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.permissionTarget).toBe('editPlanMd');
        expect(result.reason).toMatch(/항상 허용|패널/);
    });

    it('denies AX_STUDIO_DESIGN.md edits when permission=ask', () => {
        const result = decidePreToolUse(
            inWorkspace(stateAsk, 'Edit', { file_path: '/tmp/ws/AX_STUDIO_DESIGN.md' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.permissionTarget).toBe('editDesignMd');
    });

    it('allows AX_PROJECT_PLAN.md edits when permission=always', () => {
        const result = decidePreToolUse(
            inWorkspace(stateAlways, 'Edit', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md' }),
        );
        expect(result.decision).toBe('allow');
    });

    it('denies AX_PROJECT_PLAN.md edits when permission=never', () => {
        const result = decidePreToolUse(
            inWorkspace(stateNever, 'Edit', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md' }),
        );
        expect(result.decision).toBe('deny');
    });

    it('still validates .ax/state.json schema on Write in work step', () => {
        const result = decidePreToolUse(
            inWorkspace(stateAsk, 'Write', { file_path: '/tmp/ws/.ax/state.json', content: '{"oops":true}' }),
        );
        expect(result.decision).toBe('deny');
        expect(result.reason).toMatch(/schema|state\.json/i);
    });
});

describe('decidePreToolUse — non-write tools', () => {
    const state = createInitialState('plan');
    it('allows Read in any step', () => {
        expect(
            decidePreToolUse(inWorkspace(state, 'Read', { file_path: '/tmp/ws/src/app.tsx' })).decision,
        ).toBe('allow');
    });

    it('allows Bash in any step', () => {
        expect(decidePreToolUse(inWorkspace(state, 'Bash', { command: 'ls' })).decision).toBe('allow');
    });
});

describe('decidePreToolUse — MultiEdit', () => {
    const state = createInitialState('plan');

    it('denies MultiEdit targeting a forbidden path', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'MultiEdit', { file_path: '/tmp/ws/src/app.tsx', edits: [] }),
        );
        expect(result.decision).toBe('deny');
    });

    it('allows MultiEdit on AX_PROJECT_PLAN.md', () => {
        const result = decidePreToolUse(
            inWorkspace(state, 'MultiEdit', { file_path: '/tmp/ws/AX_PROJECT_PLAN.md', edits: [] }),
        );
        expect(result.decision).toBe('allow');
    });
});
