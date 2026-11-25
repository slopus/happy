import { describe, expect, it } from 'vitest';
import { createDelegationPromptLifecycle } from './delegationPrompt';

describe('delegation discovery prompt', () => {
    it('discovers live roles for a parent and keeps the prompt available until successfully sent', () => {
        const lifecycle = createDelegationPromptLifecycle({ delegatedChild: false });
        const prompt = lifecycle.getPrompt();
        expect(prompt).toContain('agent_roles with action="list"');
        expect(prompt).toContain('explicit user role/executor choice first');
        expect(prompt).toContain('autoDelegate=true');
        expect(prompt).toContain('autoDelegate=false requires an explicit user request');
        expect(prompt).toContain('Save, change, or delete roles only when the user asks');
        expect(prompt).toContain('returned taskId for revisions');
        expect(lifecycle.getPrompt()).toBe(prompt);
        lifecycle.markPromptSent();
        expect(lifecycle.getPrompt()).toBeUndefined();
    });

    it('never enables nested delegation for an actual delegated child', () => {
        const lifecycle = createDelegationPromptLifecycle({ delegatedChild: true });
        expect(lifecycle.getPrompt()).toBeUndefined();
        lifecycle.markPromptSent();
        expect(lifecycle.getPrompt()).toBeUndefined();
    });
});
