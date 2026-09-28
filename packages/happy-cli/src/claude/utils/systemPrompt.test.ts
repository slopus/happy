import { describe, expect, it } from 'vitest';

import { systemPrompt } from './systemPrompt';

describe('systemPrompt', () => {
    it('does not add tool or AI attribution to commit messages', () => {
        expect(systemPrompt).not.toMatch(/\bcommit(?:s|ting)?\b/i);
    });

    it('requires completed Ego browser rounds to be reported to the browser-steps panel', () => {
        expect(systemPrompt).toContain('ego-browser');
        expect(systemPrompt).toContain('ego-ops');
        expect(systemPrompt).toContain('mcp__happy__report_browser_step');
        expect(systemPrompt).toContain('mcp__happy__create_preview');
        expect(systemPrompt).toContain('mcp__happy__publish_preview');
        expect(systemPrompt).toContain('mcp__happy__list_previews');
        expect(systemPrompt).toContain('mcp__happy__close_preview');
        expect(systemPrompt).toContain('All previews use Cloudflare');
        expect(systemPrompt).toContain('do not launch a separate tunnel');
        expect(systemPrompt).toMatch(/meaningful completed and verified KEY STEPS/i);
        expect(systemPrompt).toMatch(/final verified browser state/i);
        expect(systemPrompt).toMatch(/Do not report waits, retries, tiny scrolls/i);
        expect(systemPrompt).toContain('one unique runId for the entire browser task');
        expect(systemPrompt).toContain('do not create a new runId per shell command');
        expect(systemPrompt).toContain('unchanged pages');
        expect(systemPrompt).toContain('sessionId');
        expect(systemPrompt).toContain('targetId');
        expect(systemPrompt).toContain('skillName');
        expect(systemPrompt.match(/mcp__happy__report_browser_step/g)).toHaveLength(1);
    });
});
