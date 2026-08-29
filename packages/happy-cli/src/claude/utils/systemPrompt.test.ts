import { describe, expect, it } from 'vitest';

import { systemPrompt } from './systemPrompt';

describe('systemPrompt', () => {
    it('does not add tool or AI attribution to commit messages', () => {
        expect(systemPrompt).not.toMatch(/\bcommit(?:s|ting)?\b/i);
    });

    it('requires completed Ego browser rounds to be reported to the browser-steps panel', () => {
        expect(systemPrompt).toContain('`ego-browser`');
        expect(systemPrompt).toContain('`ego-ops`');
        expect(systemPrompt).toContain('mcp__happy__report_browser_step');
        expect(systemPrompt).toMatch(/meaningful completed and verified browser round/i);
        expect(systemPrompt).toMatch(/before starting the next Ego browser round/i);
        expect(systemPrompt).toMatch(/final verified browser state/i);
        expect(systemPrompt).toMatch(/Do not report waits, retries, tiny scrolls/i);
        expect(systemPrompt.match(/mcp__happy__report_browser_step/g)).toHaveLength(1);
    });
});
