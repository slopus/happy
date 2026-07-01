import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

    it('plan-step: keeps user text visible-clean and injects guide/context into appendSystemPrompt', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'make a todo app',
        });
        expect(result).not.toBeNull();
        expect(result!.step).toBe('plan');
        expect(result!.userText).toBe('make a todo app');
        expect(result!.appendSystemPrompt).toMatch(/Step: plan/);
        expect(result!.appendSystemPrompt).toMatch(/<ax-dynamic-context>/);
        // Order: base prompt -> step guide -> dynamic context.
        const baseIdx = result!.appendSystemPrompt.indexOf('AX Studio AI assistant');
        const guideIdx = result!.appendSystemPrompt.indexOf('Step: plan');
        const ctxIdx = result!.appendSystemPrompt.indexOf('<ax-dynamic-context>');
        expect(baseIdx).toBeLessThan(guideIdx);
        expect(guideIdx).toBeLessThan(ctxIdx);
    });

    it('design-step: references state.plan.filePath without embedding content in the context block', async () => {
        await bootstrapWorkspace(workspace, 'design');
        await mkdir(join(workspace, 'specs', 'todo-app'), { recursive: true });
        await writeFile(join(workspace, 'specs', 'todo-app', 'prd.md'), '# My Plan\n\nbody-marker\n');
        await writeFile(
            join(workspace, '.ax', 'state.json'),
            JSON.stringify({
                version: 1,
                step: 'design',
                plan: {
                    filePath: 'specs/todo-app/prd.md',
                    completedAt: null,
                },
                design: {
                    candidates: [],
                    candidatesSource: 'claude-suggested',
                    selected: null,
                    filePath: 'AX_STUDIO_DESIGN.md',
                    completedAt: null,
                },
                work: { startedAt: null },
                history: [{ from: null, to: 'design', at: new Date().toISOString() }],
            }),
        );
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'show me designs',
        });
        expect(result!.userText).toBe('show me designs');
        expect(result!.step).toBe('design');
        expect(result!.appendSystemPrompt).toMatch(/specs\/todo-app\/prd\.md/);
        expect(result!.appendSystemPrompt).not.toMatch(/body-marker/);
    });

    it('injects base.md into appendSystemPrompt when no current value', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const result = await applyAxOrchestration({
            workspaceRoot: workspace,
            userText: 'hi',
        });
        expect(result!.appendSystemPrompt).toMatch(/AX Studio AI assistant/);
    });

    it('replaces prior AX guide/context instead of accumulating stale prompt blocks', async () => {
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

        const stepOccurrences = (second!.appendSystemPrompt.match(/Step: plan/g) || []).length;
        const contextOccurrences = (second!.appendSystemPrompt.match(/<ax-dynamic-context>/g) || []).length;
        expect(stepOccurrences).toBe(1);
        expect(contextOccurrences).toBe(1);
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
