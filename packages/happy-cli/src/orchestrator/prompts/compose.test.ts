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
    it('returns the AX Studio base prompt text mentioning all 4 modes', async () => {
        const text = await loadBasePrompt();
        expect(text).toMatch(/AX Studio AI assistant/);
        expect(text).toMatch(/plan/);
        expect(text).toMatch(/design/);
        expect(text).toMatch(/work/);
        expect(text).toMatch(/free/);
    });

    it('does not mention the removed PreToolUse hook enforcement', async () => {
        const text = await loadBasePrompt();
        expect(text).not.toMatch(/PreToolUse hook/);
        expect(text).not.toMatch(/enforces per-step write boundaries/);
    });

    it('instructs learner-facing questions to use AskUserQuestion when available', async () => {
        const text = await loadBasePrompt();
        expect(text).toMatch(/AskUserQuestion/);
        expect(text).toMatch(/clarifying question/);
        expect(text).toMatch(/plain chat text/);
    });

    it('defaults to non-developer-facing plain language', async () => {
        const text = await loadBasePrompt();
        expect(text).toMatch(/not a developer/);
        expect(text).toMatch(/plain product\/user language/);
        expect(text).toMatch(/avoid specialized engineering jargon/);
    });
});

describe('composeStepGuide', () => {
    it('loads the plan step guide', async () => {
        const guide = await composeStepGuide('plan');
        expect(guide).toMatch(/Step: plan/);
        expect(guide).toMatch(/Product Manager/);
        expect(guide).toMatch(/specs\/\[feature-slug\]\/prd\.md/);
        expect(guide).toMatch(/spec\.md/);
        expect(guide).toMatch(/context\.md/);
        expect(guide).toMatch(/AX_PROJECT_PLAN\.md.*explicitly requested/i);
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

    it('loads the free step guide', async () => {
        const guide = await composeStepGuide('free');
        expect(guide).toMatch(/Step: free/);
        expect(guide).toMatch(/full-stack/i);
        expect(guide).toMatch(/TDD/);
    });
});

describe('composeDynamicContext', () => {
    it('plan step: embeds state summary, no attachments', async () => {
        const state = createInitialState('plan');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/"step":\s*"plan"/);
        expect(ctx).toMatch(/"filePath":\s*"specs\/\[feature-slug\]\/prd\.md"/);
        expect(ctx).toMatch(/state\.json/);
        // No attachments expected in plan step
        expect(ctx).not.toMatch(/AX_PROJECT_PLAN\.md\n```/);
        expect(ctx).not.toMatch(/AX_STUDIO_DESIGN\.md\n```/);
    });

    it('design step: references state.plan.filePath when present without embedding content', async () => {
        const state = createInitialState('design');
        state.plan.filePath = 'specs/todo-app/prd.md';
        await mkdir(join(workspace, 'specs', 'todo-app'), { recursive: true });
        await writeFile(join(workspace, state.plan.filePath), '# Test Plan\n\n## 목표\nbuild it\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/"step":\s*"design"/);
        expect(ctx).toMatch(/specs\/todo-app\/prd\.md/);
        expect(ctx).not.toMatch(/build it/);
    });

    it('design step: handles missing state.plan.filePath gracefully', async () => {
        const state = createInitialState('design');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/specs\/\[feature-slug\]\/prd\.md/);
        expect(ctx).toMatch(/not found|missing|not yet created/i);
    });

    it('design step: keeps legacy AX_PROJECT_PLAN.md states compatible', async () => {
        const state = createInitialState('design');
        state.plan.filePath = 'AX_PROJECT_PLAN.md';
        await writeFile(join(workspace, 'AX_PROJECT_PLAN.md'), '# Legacy Plan\nbody A\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/AX_PROJECT_PLAN\.md/);
        expect(ctx).not.toMatch(/body A/);
    });

    it('work step: references plan AND design when both present without embedding content', async () => {
        const state = createInitialState('work');
        state.plan.filePath = 'specs/todo-app/prd.md';
        await mkdir(join(workspace, 'specs', 'todo-app'), { recursive: true });
        await writeFile(join(workspace, state.plan.filePath), '# Plan\nbody A\n');
        await writeFile(join(workspace, 'AX_STUDIO_DESIGN.md'), '# Design\nbody B\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/specs\/todo-app\/prd\.md/);
        expect(ctx).toMatch(/AX_STUDIO_DESIGN\.md/);
        expect(ctx).not.toMatch(/body A/);
        expect(ctx).not.toMatch(/body B/);
    });

    it('work step: notes which attachments are missing', async () => {
        const state = createInitialState('work');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/specs\/\[feature-slug\]\/prd\.md/);
        expect(ctx).toMatch(/AX_STUDIO_DESIGN\.md/);
        expect(ctx).toMatch(/not found|missing|not yet created/i);
    });

    it('free step: references plan + design when present, skips embedding content', async () => {
        const state = createInitialState('free');
        state.plan.filePath = 'specs/todo-app/prd.md';
        await mkdir(join(workspace, 'specs', 'todo-app'), { recursive: true });
        await writeFile(join(workspace, state.plan.filePath), '# Plan\nfree-body-plan\n');
        const ctx = await composeDynamicContext(workspace, state);
        expect(ctx).toMatch(/"step":\s*"free"/);
        expect(ctx).toMatch(/specs\/todo-app\/prd\.md/);
        expect(ctx).not.toMatch(/free-body-plan/);
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
