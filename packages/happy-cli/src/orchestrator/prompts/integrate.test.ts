import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAxOrchestration } from './integrate';
import { bootstrapWorkspace } from '../state/bootstrap';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-integrate-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('applyAxOrchestration', () => {
    it('returns null when workspace has no .ax/state.json', async () => {
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hello',
        });
        expect(result).toBeNull();
    });

    it('plan-step: prepends step guide + dynamic context to user text', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'make a todo app',
        });
        expect(result).not.toBeNull();
        expect(result!.userText).toMatch(/Step: plan/);
        expect(result!.userText).toMatch(/<ax-dynamic-context>/);
        expect(result!.userText).toMatch(/make a todo app/);
        // Order: step guide → dynamic context → original user text
        const guideIdx = result!.userText.indexOf('Step: plan');
        const ctxIdx = result!.userText.indexOf('<ax-dynamic-context>');
        const userIdx = result!.userText.indexOf('make a todo app');
        expect(guideIdx).toBeLessThan(ctxIdx);
        expect(ctxIdx).toBeLessThan(userIdx);
    });

    it('design-step: attaches AX_PROJECT_PLAN.md content in the context block', async () => {
        await bootstrapWorkspace(workspace, 'design');
        await writeFile(join(workspace, 'AX_PROJECT_PLAN.md'), '# My Plan\n\nbody-marker\n');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'show me designs',
        });
        expect(result!.userText).toMatch(/body-marker/);
    });

    it('injects base.md into appendSystemPrompt when no current value', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi',
        });
        expect(result!.appendSystemPrompt).toMatch(/AX Studio AI assistant/);
    });

    it('preserves an existing user-supplied appendSystemPrompt', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi',
            currentAppendSystemPrompt: 'CUSTOM USER PROMPT',
        });
        // Both AX base and user's custom prompt should be present
        expect(result!.appendSystemPrompt).toMatch(/AX Studio AI assistant/);
        expect(result!.appendSystemPrompt).toMatch(/CUSTOM USER PROMPT/);
    });

    it('is idempotent — re-applying does not duplicate the base prompt', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const first = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi',
        });
        const second = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi again',
            currentAppendSystemPrompt: first!.appendSystemPrompt,
        });
        const occurrences = (second!.appendSystemPrompt!.match(/AX Studio AI assistant/g) || []).length;
        expect(occurrences).toBe(1);
    });

    it('returns null when state.json is corrupt (orchestration disabled gracefully)', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await writeFile(join(workspace, '.ax', 'state.json'), '{ garbage');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi',
        });
        expect(result).toBeNull();
    });
});
