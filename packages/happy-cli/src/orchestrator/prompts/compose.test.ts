import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeStepGuide, composeDynamicContext, loadBasePrompt } from './compose';
import { createInitialState } from '../state/schema';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-compose-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('loadBasePrompt', () => {
    it('returns the AX Studio base prompt text', async () => {
        const text = await loadBasePrompt();
        expect(text).toMatch(/AX Studio AI assistant/);
        expect(text).toMatch(/plan/);
        expect(text).toMatch(/design/);
        expect(text).toMatch(/work/);
    });
});

describe('composeStepGuide', () => {
    it('loads the plan step guide', async () => {
        const guide = await composeStepGuide('plan');
        expect(guide).toMatch(/Step: plan/);
        expect(guide).toMatch(/Product Manager/);
        expect(guide).toMatch(/AX_PROJECT_PLAN\.md/);
    });

    it('loads the design step guide', async () => {
        const guide = await composeStepGuide('design');
        expect(guide).toMatch(/Step: design/);
        expect(guide).toMatch(/AX_STUDIO_DESIGN\.md/);
    });

    it('loads the work step guide', async () => {
        const guide = await composeStepGuide('work');
        expect(guide).toMatch(/Step: work/);
        expect(guide).toMatch(/TDD/);
    });
});

describe('composeDynamicContext', () => {
    it('plan step: embeds state summary, no attachments', async () => {
        const state = createInitialState('plan');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/"step":\s*"plan"/);
        expect(ctx).toMatch(/state\.json/);
        // No attachments expected in plan step
        expect(ctx).not.toMatch(/AX_PROJECT_PLAN\.md\n```/);
        expect(ctx).not.toMatch(/AX_STUDIO_DESIGN\.md\n```/);
    });

    it('design step: attaches AX_PROJECT_PLAN.md when present', async () => {
        const state = createInitialState('design');
        await writeFile(join(workspace, 'AX_PROJECT_PLAN.md'), '# Test Plan\n\n## 🎯 목표\nbuild it\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/"step":\s*"design"/);
        expect(ctx).toMatch(/AX_PROJECT_PLAN\.md/);
        expect(ctx).toMatch(/build it/);
    });

    it('design step: handles missing AX_PROJECT_PLAN.md gracefully', async () => {
        const state = createInitialState('design');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/AX_PROJECT_PLAN\.md/);
        expect(ctx).toMatch(/not found|missing|not yet created/i);
    });

    it('work step: attaches plan AND design when both present', async () => {
        const state = createInitialState('work');
        await writeFile(join(workspace, 'AX_PROJECT_PLAN.md'), '# Plan\nbody A\n');
        await writeFile(join(workspace, 'AX_STUDIO_DESIGN.md'), '# Design\nbody B\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/body A/);
        expect(ctx).toMatch(/body B/);
    });

    it('work step: notes which attachments are missing', async () => {
        const state = createInitialState('work');
        await writeFile(join(workspace, 'AX_PROJECT_PLAN.md'), '# Plan\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/AX_STUDIO_DESIGN\.md/);
        expect(ctx).toMatch(/not found|missing|not yet created/i);
    });

    it('state summary includes design.candidates', async () => {
        const state = createInitialState('design');
        state.design.candidates = ['linear', 'stripe', 'bmw-m'];
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/linear/);
        expect(ctx).toMatch(/stripe/);
        expect(ctx).toMatch(/bmw-m/);
    });
});
